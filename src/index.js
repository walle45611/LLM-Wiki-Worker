import { Hono } from "hono";
import {
    buildIntentRouterSystemPrompt,
    buildIntentRouterUserPrompt,
    buildSummaryReplyAssistantPrompt,
    buildSummaryLookupAssistantPrompt,
    buildSummaryLookupUserPrompt,
    buildSummaryUserPrompt,
} from "./prompts.js";
import {
    buildDateVariants,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    fetchSummaryFiles,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
} from "./knowledge.js";
import { logError, logInfo, logWarn, toPreview } from "./logger.js";
import {
    buildAssistantToolCallMessage,
    buildReadingFlowTools,
    executeSummaryToolCall,
    extractToolCalls,
    getToolCallId,
    getToolCallName,
    parseToolCallArguments,
} from "./ai/tools.js";
import {
    buildIntentRouterResponseFormat,
    buildSummaryLookupResponseFormat,
    buildSummaryReplyResponseFormat,
} from "./ai/format.js";
import { extractAiText, extractSummaryReplyFromResult } from "./ai/response.js";
import {
    buildAiInputLog,
    runAiTextGeneration,
    toPreviewWithLimit,
} from "./ai/runner.js";
import { fetchGithubFile } from "./github/client.js";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const AGENTS_PATH = "AGENTS.md";
const DEFAULT_MAX_TOKENS = 4096;

export { extractAiText, extractSummaryReplyFromResult, fetchGithubFile };

export const app = new Hono();

app.onError((error) => {
    logError("worker.unhandled_error", {}, error);
    return new Response("Internal Server Error", { status: 500 });
});

app.get("/", (c) => c.json({ ok: true, service: "llmwikiworker" }));

app.post("/webhook", async (c) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const bodyText = await c.req.text();
    const signature = c.req.header("x-line-signature");
    logInfo("webhook.received", {
        requestId,
        bodyLength: bodyText.length,
        hasSignature: Boolean(signature),
    });

    if (
        !(await verifyLineSignature(
            bodyText,
            signature,
            c.env.LINE_CHANNEL_SECRET,
        ))
    ) {
        logWarn("webhook.signature_failed", { requestId });
        return c.text("Unauthorized", 401);
    }

    const payload = JSON.parse(bodyText);
    const events = Array.isArray(payload.events) ? payload.events : [];
    logInfo("webhook.parsed", { requestId, eventCount: events.length });
    c.executionCtx.waitUntil(
        Promise.all(
            events.map((event, index) =>
                handleLineEvent(event, c.env, {
                    requestId,
                    eventIndex: index,
                    totalEvents: events.length,
                }),
            ),
        )
            .then(() => {
                logInfo("webhook.background_completed", {
                    requestId,
                    elapsedMs: Date.now() - startedAt,
                });
            })
            .catch((error) => {
                logError("webhook.background_failed", { requestId }, error);
            }),
    );

    return c.text("OK", 200);
});

export default app;

export async function handleLineEvent(event, env, trace = {}) {
    const eventStartedAt = Date.now();
    logInfo("line.event_received", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        totalEvents: trace.totalEvents,
        type: event?.type,
        messageType: event?.message?.type,
        hasReplyToken: Boolean(event?.replyToken),
    });

    if (
        !event?.replyToken ||
        event.replyToken === "00000000000000000000000000000000"
    ) {
        logWarn("line.invalid_reply_token", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
        });
        return;
    }

    if (event.type !== "message" || event.message?.type !== "text") {
        logInfo("line.unsupported_message", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
        });
        return replyToLine(
            event.replyToken,
            "目前只支援文字訊息。",
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }

    const text = event.message.text.trim();
    let currentDateInfo = null;

    try {
        const config = getRuntimeConfig(env);
        logInfo("line.runtime_config_loaded", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            githubOwner: config.githubOwner,
            githubRepo: config.githubRepo,
            githubRef: config.githubRef,
            githubLogPath: config.githubLogPath,
            githubIndexPath: config.githubIndexPath,
            timezone: config.timezone,
            summaryAiModel: config.summaryAiModel,
            summaryTimeoutMs: config.summaryTimeoutMs,
        });

        currentDateInfo = getCurrentDateInfo(config.timezone);
        const agentsContent = await fetchGithubFile(config, AGENTS_PATH, {
            logInfo,
        });
        logInfo("line.agents_loaded", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            length: agentsContent.length,
        });
        logInfo("line.user_query", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            textPreview: toPreview(text),
            currentDate: currentDateInfo.isoDate,
        });

        const route = await resolveFinalRoute({
            text,
            currentDateInfo,
            config,
            routerInstructions: agentsContent,
            aiBinding: env.AI,
            aiModel: config.summaryAiModel,
            trace,
        });
        if (route.rule === "D" && route.date) {
            const targetDateInfo = buildDateInfoFromIsoDate(
                route.date,
                currentDateInfo.timezone,
            );
            logInfo("line.target_date_resolved_ai", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                isoDate: targetDateInfo.isoDate,
                displayDate: targetDateInfo.displayDate,
                weekday: targetDateInfo.weekday,
                rule: route.rule || "",
            });
            const summarizeStartedAt = Date.now();
            const summary = await summarizeRuleDWithTools({
                userText: text,
                currentDateInfo,
                targetDateInfo,
                aiBinding: env.AI,
                aiModel: config.summaryAiModel,
                config,
                context: {
                    timeoutMs: config.summaryTimeoutMs,
                    rule: route.rule || "D",
                    ruleContent: route.ruleContent || "",
                },
                trace: {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                },
            });
            const message = clampLineText(summary);
            logInfo("line.summary_generated", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                summaryLength: summary.length,
                summaryPreview: toPreview(summary),
                replyLength: message.length,
                elapsedMs: Date.now() - summarizeStartedAt,
                totalElapsedMs: Date.now() - eventStartedAt,
            });
            return replyToLine(
                event.replyToken,
                message,
                env.LINE_CHANNEL_ACCESS_TOKEN,
            );
        }

        if (route.rule === "B") {
            const indexContent = await fetchGithubFile(
                config,
                config.githubIndexPath,
                { logInfo },
            );
            return await handleRuleBFlow({
                text,
                currentDateInfo,
                config,
                env,
                trace,
                indexContent,
                rule: route.rule,
                ruleContent: route.ruleContent || "",
                eventStartedAt,
                replyToken: event.replyToken,
            });
        }

        throw new Error("Unsupported routed rule");
    } catch (error) {
        logError(
            "line.handle_failed",
            {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                totalElapsedMs: Date.now() - eventStartedAt,
            },
            error,
        );
        const fallbackMessage = buildUserErrorMessage(error, currentDateInfo);
        return replyToLine(
            event.replyToken,
            fallbackMessage,
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }
}

async function handleRuleBFlow({
    text,
    currentDateInfo,
    config,
    env,
    trace,
    indexContent,
    rule,
    ruleContent,
    eventStartedAt,
    replyToken,
}) {
    const entries = parseSummaryIndexEntries(indexContent);
    if (entries.length === 0) {
        return replyToLine(
            replyToken,
            "目前找不到可查詢的 summaries 索引。",
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }

    const selectedPath = await resolveRuleBSummaryPath(
        text,
        indexContent,
        entries,
        env.AI,
        config.summaryAiModel,
        { requestId: trace.requestId, eventIndex: trace.eventIndex },
        {
            timeoutMs: config.summaryTimeoutMs,
            rule,
            ruleContent,
        },
    );

    if (!selectedPath) {
        return replyToLine(
            replyToken,
            "我目前找不到對應的主題摘要，你可以再多給我一點關鍵字。",
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }

    const summarySources = await fetchSummaryFiles([selectedPath], (path) =>
        fetchGithubFile(config, path, { logInfo }),
    );
    if (summarySources.files.length === 0) {
        return replyToLine(
            replyToken,
            "我有找到可能的主題，但目前無法讀取對應 summary 檔案。",
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }

    const formatted = await summarizeRuleBSummary(
        summarySources.files[0],
        text,
        currentDateInfo,
        env.AI,
        config.summaryAiModel,
        {
            timeoutMs: config.summaryTimeoutMs,
            rule,
            ruleContent,
        },
        { requestId: trace.requestId, eventIndex: trace.eventIndex },
    );
    const message = clampLineText(formatted);
    logInfo("line.query_summary_generated", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        selectedPath,
        replyLength: message.length,
        totalElapsedMs: Date.now() - eventStartedAt,
    });
    return replyToLine(replyToken, message, env.LINE_CHANNEL_ACCESS_TOKEN);
}

export function getRuntimeConfig(env) {
    const required = [
        "LINE_CHANNEL_ACCESS_TOKEN",
        "LINE_CHANNEL_SECRET",
        "GITHUB_OWNER",
        "GITHUB_REPO",
        "GITHUB_TOKEN",
    ];

    for (const key of required) {
        if (!env[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }

    return {
        githubOwner: env.GITHUB_OWNER,
        githubRepo: env.GITHUB_REPO,
        githubRef: env.GITHUB_REF || "main",
        githubLogPath: env.GITHUB_FILE_PATH || "wiki/log.md",
        githubIndexPath: env.GITHUB_INDEX_PATH || "wiki/index.md",
        githubToken: env.GITHUB_TOKEN,
        timezone: env.APP_TIMEZONE || "Asia/Taipei",
        summaryAiModel:
            env.SUMMARY_AI_MODEL ||
            env.AI_MODEL ||
            "@cf/meta/llama-3.1-8b-instruct",
        summaryTimeoutMs: Number(env.SUMMARY_TIMEOUT_MS || 12000),
    };
}

export async function verifyLineSignature(bodyText, signature, channelSecret) {
    if (!signature || !channelSecret) {
        return false;
    }

    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(channelSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signed = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(bodyText),
    );
    const actual = arrayBufferToBase64(signed);
    return timingSafeEqual(actual, signature);
}

export function timingSafeEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }

    let result = 0;
    for (let i = 0; i < left.length; i += 1) {
        result |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return result === 0;
}

export function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function getCurrentDateInfo(timezone, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const weekday = new Intl.DateTimeFormat("zh-TW", {
        timeZone: timezone,
        weekday: "long",
    }).format(now);

    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    return {
        year,
        month,
        day,
        isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
        displayDate: `${year}/${pad2(month)}/${pad2(day)}`,
        weekday,
        timezone,
    };
}

export function buildDateInfoFromIsoDate(isoDate, timezone) {
    const [year, month, day] = isoDate.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const weekday = new Intl.DateTimeFormat("zh-TW", {
        timeZone: timezone,
        weekday: "long",
    }).format(utcDate);

    return {
        year,
        month,
        day,
        isoDate,
        displayDate: `${year}/${pad2(month)}/${pad2(day)}`,
        weekday,
        timezone,
    };
}

export function detectReadingLookupDateFromText(userText, currentDateInfo) {
    const text = String(userText || "").trim();
    if (!text || !looksLikeReadingLookupText(text)) {
        return null;
    }

    const explicitDate =
        tryParseIsoLikeDate(text) ||
        tryParseMonthDayDate(text, currentDateInfo);
    if (explicitDate) {
        return explicitDate;
    }
    if (/前天/.test(text)) {
        return shiftDateByDays(currentDateInfo, -2).isoDate;
    }
    if (/昨天|昨日/.test(text)) {
        return shiftDateByDays(currentDateInfo, -1).isoDate;
    }
    if (/今天|今日/.test(text)) {
        return currentDateInfo.isoDate;
    }
    return null;
}

function buildDateInfoFromDate(date, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    return buildDateInfoFromIsoDate(
        `${year}-${pad2(month)}-${pad2(day)}`,
        timezone,
    );
}

export function pad2(value) {
    return String(value).padStart(2, "0");
}

export async function resolveIntentAndRule(
    userText,
    currentDateInfo,
    instructions,
    aiBinding,
    aiModel,
    trace = {},
) {
    const messages = [
        {
            role: "assistant",
            content: buildIntentRouterSystemPrompt(currentDateInfo),
        },
        {
            role: "user",
            content: buildIntentRouterUserPrompt(userText),
        },
    ];
    logInfo("ai.intent_router_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        instructionLength: instructions.length,
        instructionPreview: toPreviewWithLimit(instructions, 1200),
        inputMessages: buildAiInputLog(messages),
    });
    const startedAt = Date.now();
    const { result, text } = await runAiTextGeneration({
        aiBinding,
        aiModel,
        instructions,
        messages,
        responseFormat: buildIntentRouterResponseFormat(),
        temperature: 0.1,
        timeoutMs: 12000,
        timeoutMessage: "Workers AI intent routing timed out",
        trace,
        eventBase: "ai.intent_router",
    });
    let parsed = null;
    try {
        const response = result?.response;
        if (
            response &&
            typeof response === "object" &&
            !Array.isArray(response)
        ) {
            parsed = normalizeRuleRoute(response, currentDateInfo);
        } else {
            parsed = parseIntentRouter(
                text || extractAiText(result),
                currentDateInfo,
            );
        }
    } catch (error) {
        logWarn("ai.intent_router_parse_failed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
        parsed = { rule: "B" };
    }
    logInfo("ai.intent_router_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        rule: parsed.rule || "",
        date: parsed.date || "",
        outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
        elapsedMs: Date.now() - startedAt,
    });
    return parsed;
}

async function resolveFinalRoute({
    text,
    currentDateInfo,
    config,
    routerInstructions,
    aiBinding,
    aiModel,
    trace,
}) {
    const routeTrace = {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
    };
    let route = await resolveIntentAndRule(
        text,
        currentDateInfo,
        routerInstructions,
        aiBinding,
        aiModel,
        routeTrace,
    );

    const forcedDate = detectReadingLookupDateFromText(text, currentDateInfo);
    if (forcedDate && route.rule !== "D") {
        route = { ...route, rule: "D", date: forcedDate };
        logInfo("line.route_overridden_to_rule_d", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            reason: "local_reading_lookup_detected",
            forcedDate,
        });
    }

    if (route.rule === "B" || route.rule === "D") {
        const ruleContext = await resolveRuleContext(
            route.rule,
            config,
            routeTrace,
        );
        route = {
            ...route,
            rulePath: ruleContext.rulePath,
            ruleContent: ruleContext.ruleContent,
        };
    }
    return route;
}

async function resolveRuleContext(rule, config, trace = {}) {
    const treeResult = await executeSummaryToolCall(
        "get_file_tree",
        { base_path: "wiki/rules", max_depth: 2 },
        {
            config,
            trace,
            logInfo,
        },
    );
    const resolvedRule = await executeSummaryToolCall(
        "resolve_rule_file",
        { rule, tree: treeResult.tree || [] },
        {
            trace,
            logInfo,
        },
    );
    if (!resolvedRule?.matched || !resolvedRule?.path) {
        throw new Error(`Unable to resolve rule file for rule ${rule}`);
    }
    const fileResult = await executeSummaryToolCall(
        "get_file",
        { path: resolvedRule.path },
        {
            config,
            trace,
            logInfo,
        },
    );
    return {
        rulePath: fileResult.path,
        ruleContent: fileResult.content || "",
    };
}

export function parseSummaryLookupDecision(text) {
    const trimmed = text.trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        throw new Error(
            "Workers AI returned an invalid summary lookup payload",
        );
    }

    const candidate = trimmed.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(candidate);
    return parsed;
}

export async function resolveRuleBSummaryPath(
    userText,
    indexContent,
    summaryEntries,
    aiBinding,
    aiModel,
    trace = {},
    context = {},
) {
    assertAiBindingConfigured(aiBinding);

    const instructions = String(context.ruleContent || "").trim();
    const messages = [
        {
            role: "assistant",
            content: buildSummaryLookupAssistantPrompt(),
        },
        {
            role: "user",
            content: buildSummaryLookupUserPrompt(userText, indexContent),
        },
    ];

    logInfo("ai.summary_lookup_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        candidateCount: summaryEntries.length,
        instructionLength: instructions.length,
        instructionPreview: toPreviewWithLimit(instructions, 1200),
        inputMessages: buildAiInputLog(messages),
    });

    const startedAt = Date.now();
    const { text, result } = await runAiTextGeneration({
        aiBinding,
        aiModel,
        instructions,
        messages,
        responseFormat: buildSummaryLookupResponseFormat(),
        temperature: 0.1,
        timeoutMs: context.timeoutMs || 12000,
        timeoutMessage: "Workers AI summary lookup timed out",
        trace,
        eventBase: "ai.summary_lookup",
    });
    let parsed = null;
    const response = result?.response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
        parsed = response;
    } else {
        try {
            parsed = parseSummaryLookupDecision(extractAiText(result));
        } catch {
            parsed = null;
        }
    }
    if (!parsed) {
        if (summaryEntries.length === 1) {
            const fallbackPath = summaryEntries[0]?.path || null;
            logWarn("ai.summary_lookup_single_candidate_fallback", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                fallbackPath: fallbackPath || "",
                outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
                outputTextPreview: toPreviewWithLimit(text, 1200),
            });
            return fallbackPath;
        }
        logWarn("ai.summary_lookup_parse_failed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
            outputTextPreview: toPreviewWithLimit(text, 1200),
            errorMessage:
                "Workers AI returned an invalid summary lookup payload",
        });
        return null;
    }
    logInfo("ai.summary_lookup_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        elapsedMs: Date.now() - startedAt,
        decision: parsed.intent || "unknown",
        path: parsed.path || "",
        outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
        outputTextPreview: toPreviewWithLimit(text, 1200),
    });

    if (
        parsed.intent === "unsupported" &&
        summaryEntries.length === 1 &&
        summaryEntries[0]?.path
    ) {
        const fallbackPath = summaryEntries[0].path;
        logWarn("ai.summary_lookup_unsupported_single_candidate_fallback", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            fallbackPath,
            outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
            outputTextPreview: toPreviewWithLimit(text, 1200),
        });
        return fallbackPath;
    }

    if (parsed.intent !== "summary_lookup" || !parsed.path) {
        return null;
    }
    const normalizedPath = normalizeWikiPath(parsed.path);
    const matched = summaryEntries.find((entry) => entry.path === normalizedPath);
    return matched?.path || null;
}

function parseIntentRouter(text, currentDateInfo) {
    const trimmed = String(text || "").trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        throw new Error("Workers AI returned an invalid intent router payload");
    }
    const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    return normalizeRuleRoute(parsed, currentDateInfo);
}

function normalizeRuleRoute(payload, currentDateInfo) {
    if (!payload || typeof payload !== "object") {
        throw new Error("Workers AI returned an invalid intent router payload");
    }
    const normalizedRule = String(payload.rule || "")
        .trim()
        .toUpperCase();
    if (normalizedRule === "D") {
        const normalized = { rule: "D" };
        if (/^\d{4}-\d{2}-\d{2}$/.test(payload.date || "")) {
            normalized.date = payload.date;
        } else {
            normalized.date = currentDateInfo.isoDate;
        }
        return normalized;
    }
    return { rule: "B" };
}

function looksLikeReadingLookupText(text) {
    return /(讀了什麼|看了什麼|閱讀紀錄|讀過什麼|what did i read)/i.test(text);
}

function tryParseIsoLikeDate(text) {
    const match = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
    if (!match) {
        return null;
    }
    return buildIsoDateIfValid(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
    );
}

function tryParseMonthDayDate(text, currentDateInfo) {
    const match = text.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
    if (!match) {
        return null;
    }
    return buildIsoDateIfValid(
        currentDateInfo.year,
        Number(match[1]),
        Number(match[2]),
    );
}

function buildIsoDateIfValid(year, month, day) {
    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        !Number.isInteger(day)
    ) {
        return null;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day
    ) {
        return null;
    }
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function shiftDateByDays(currentDateInfo, days) {
    const date = new Date(
        Date.UTC(
            currentDateInfo.year,
            currentDateInfo.month - 1,
            currentDateInfo.day,
        ),
    );
    date.setUTCDate(date.getUTCDate() + days);
    return buildDateInfoFromDate(date, currentDateInfo.timezone);
}

export async function summarizeRuleDWithTools({
    userText,
    currentDateInfo,
    targetDateInfo,
    aiBinding,
    aiModel,
    config,
    context = {},
    trace = {},
}) {
    assertAiBindingConfigured(aiBinding);

    const instructions = String(context.ruleContent || "").trim();
    const messages = [
        {
            role: "user",
            content: `使用者問題：${userText}\n目標日期：${targetDateInfo.isoDate}\n指定規則：${context.rule || "D"}\n今天基準：${currentDateInfo.displayDate} ${currentDateInfo.weekday} (${currentDateInfo.timezone})`,
        },
    ];

    const readingToolNames = [
        "get_log_for_date",
        "resolve_summary_paths",
        "get_summary_files",
    ];
    const tools = buildReadingFlowTools().filter((tool) =>
        readingToolNames.includes(tool.function?.name),
    );
    const toolExecutionContext = {
        config,
        currentDateInfo,
        trace,
        buildDateInfoFromIsoDate,
        parseSummaryIndex,
        normalizeWikiPath,
        extractSummaryReferencesFromLog,
        extractLogForDate,
        fetchSummaryFiles,
        logInfo,
    };
    const runSummaryTool = (name, args) =>
        executeSummaryToolCall(name, args, toolExecutionContext);
    logInfo("ai.summary_tool_planning_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        targetDate: targetDateInfo.isoDate,
        instructionLength: instructions.length,
        instructionPreview: toPreviewWithLimit(instructions, 1200),
        inputMessages: buildAiInputLog(messages),
        tools: tools.map((tool) => tool.function?.name).filter(Boolean),
    });

    const summarizeStartedAt = Date.now();
    let conversation = [...messages];
    let latestFiles = null;
    let unresolvedReferences = [];
    let resolvedSummaryPaths = [];
    const maxRounds = 6;
    for (let round = 0; round < maxRounds; round += 1) {
        const roundStartedAt = Date.now();
        let roundTimer = null;
        const result = await Promise.race([
            aiBinding.run(aiModel, {
                instructions,
                messages: conversation,
                tools,
                reasoning: {
                    effort: round === 0 ? "medium" : "low",
                    summary: "concise",
                },
                max_tokens: DEFAULT_MAX_TOKENS,
                temperature: 0.1,
            }),
            new Promise((_, reject) => {
                roundTimer = setTimeout(
                    () => reject(new Error("Workers AI summary timed out")),
                    context.timeoutMs || 12000,
                );
            }),
        ]).finally(() => {
            if (roundTimer) {
                clearTimeout(roundTimer);
            }
        });
        const toolCalls = extractToolCalls(result);
        logInfo("ai.summary_tool_round_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            toolCallCount: toolCalls.length,
            outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
            elapsedMs: Date.now() - roundStartedAt,
        });

        if (toolCalls.length === 0) {
            break;
        }

        const toolMessages = [];
        const assistantCallMessage = buildAssistantToolCallMessage(toolCalls);
        for (let index = 0; index < toolCalls.length; index += 1) {
            const toolCall = toolCalls[index];
            const name = getToolCallName(toolCall);
            const id = getToolCallId(toolCall, index);
            const args = parseToolCallArguments(toolCall);
            const toolResult = await runSummaryTool(name, args);
            if (name === "get_summary_files") {
                latestFiles = toolResult?.files || [];
            }
            if (name === "resolve_summary_paths") {
                unresolvedReferences = toolResult?.unresolvedReferences || [];
                resolvedSummaryPaths = toolResult?.summaryPaths || [];
            }
            toolMessages.push({
                role: "tool",
                tool_call_id: id,
                name,
                content: JSON.stringify(toolResult),
            });
        }
        conversation = [...conversation, assistantCallMessage, ...toolMessages];
        if (Array.isArray(latestFiles) && latestFiles.length > 0) {
            break;
        }
    }

    if (!latestFiles && resolvedSummaryPaths.length === 0) {
        const logResult = await runSummaryTool("get_log_for_date", {
            date: targetDateInfo.isoDate,
        });
        const resolvedResult = await runSummaryTool("resolve_summary_paths", {
            references: logResult?.references || [],
        });
        resolvedSummaryPaths = resolvedResult?.summaryPaths || [];
        unresolvedReferences = resolvedResult?.unresolvedReferences || [];

        const filesResult = await runSummaryTool("get_summary_files", {
            paths: resolvedSummaryPaths,
        });
        latestFiles = filesResult?.files || [];
        unresolvedReferences = [
            ...unresolvedReferences,
            ...(filesResult?.missingPaths || []),
        ];
        logInfo("ai.summary_tool_forced_pipeline_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            referenceCount: (logResult?.references || []).length,
            resolvedCount: resolvedSummaryPaths.length,
            foundCount: latestFiles.length,
        });
    }

    if (!latestFiles && resolvedSummaryPaths.length > 0) {
        const summarySources = await fetchSummaryFiles(
            resolvedSummaryPaths,
            (path) => fetchGithubFile(config, path, { logInfo }),
        );
        latestFiles = summarySources.files;
        unresolvedReferences = [
            ...unresolvedReferences,
            ...(summarySources.missingPaths || []),
        ];
        logInfo("ai.summary_tool_postfetch_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            resolvedCount: resolvedSummaryPaths.length,
            foundCount: latestFiles.length,
            missingCount: (summarySources.missingPaths || []).length,
        });
    }

    if (Array.isArray(latestFiles) && latestFiles.length === 0) {
        logInfo("ai.summary_no_files_confirmed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            targetDate: targetDateInfo.isoDate,
        });
        return `${targetDateInfo.displayDate} 沒有可摘要的 summaries 紀錄。`;
    }
    if (Array.isArray(latestFiles) && latestFiles.length > 0) {
        const summary = await summarizeReadingLog(
            latestFiles,
            currentDateInfo,
            targetDateInfo,
            aiBinding,
            aiModel,
            {
                timeoutMs: context.timeoutMs,
                ruleContent: context.ruleContent || "",
                unresolvedReferences,
            },
            trace,
        );
        logInfo("ai.summary_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            length: summary.length,
            mode: "tools_to_shared_summary",
            preview: toPreview(summary),
            elapsedMs: Date.now() - summarizeStartedAt,
        });
        return summary;
    }

    return `${targetDateInfo.displayDate} 有紀錄，但目前無法生成摘要。`;
}

export async function summarizeReadingLog(
    summaryFiles,
    currentDateInfo,
    targetDateInfo,
    aiBinding,
    aiModel,
    context,
    trace = {},
) {
    assertAiBindingConfigured(aiBinding);
    return generateSharedSummary({
        summaryFiles,
        currentDateInfo,
        targetDateInfo,
        aiBinding,
        aiModel,
        context,
        trace,
        eventBase: "ai.summary",
        startedEvent: "ai.summary_started",
        completedEvent: "ai.summary_completed",
        emptyEvent: "ai.summary_empty_output",
        timeoutMessage: "Workers AI summary timed out",
        emptyMessage: `${targetDateInfo.displayDate} 有紀錄，但目前無法生成摘要。`,
    });
}

export async function summarizeRuleBSummary(
    summaryFile,
    userText,
    currentDateInfo,
    aiBinding,
    aiModel,
    context,
    trace = {},
) {
    assertAiBindingConfigured(aiBinding);
    return generateSharedSummary({
        summaryFiles: [summaryFile],
        currentDateInfo,
        aiBinding,
        aiModel,
        context: {
            ...context,
            userText,
        },
        trace,
        eventBase: "ai.query_summary",
        startedEvent: "ai.query_summary_started",
        completedEvent: "ai.query_summary_completed",
        emptyEvent: "ai.query_summary_empty_output",
        timeoutMessage: "Workers AI query summary timed out",
        emptyMessage: "我有找到相關的 summary，但目前無法整理成回覆。",
    });
}

async function generateSharedSummary({
    summaryFiles,
    currentDateInfo,
    targetDateInfo = null,
    aiBinding,
    aiModel,
    context,
    trace = {},
    eventBase,
    startedEvent,
    completedEvent,
    emptyEvent,
    timeoutMessage,
    emptyMessage,
}) {
    const instructions = String(context.ruleContent || "").trim();
    const messages = [
        {
            role: "assistant",
            content: buildSummaryReplyAssistantPrompt(),
        },
        {
            role: "assistant",
            content:
                "請直接輸出純文字內容，不要使用 Markdown 格式，並可適度加入必要 Emoji。",
        },
        {
            role: "user",
            content: buildSummaryUserPrompt(summaryFiles, {
                targetDateInfo,
                userText: context.userText,
                unresolvedReferences: context.unresolvedReferences,
            }),
        },
    ];

    logInfo(startedEvent, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        summaryFileCount: summaryFiles.length,
        currentDate: currentDateInfo.isoDate,
        targetDate: targetDateInfo?.isoDate || "",
        unresolvedCount: context.unresolvedReferences?.length || 0,
        timeoutMs: context.timeoutMs,
        instructionLength: instructions.length,
        instructionPreview: toPreviewWithLimit(instructions, 1200),
        inputMessages: buildAiInputLog(messages),
    });
    const startedAt = Date.now();
    const { text, result, mode } = await runAiTextGeneration({
        aiBinding,
        aiModel,
        instructions,
        messages,
        responseFormat: buildSummaryReplyResponseFormat(),
        extractText: extractSummaryReplyFromResult,
        temperature: 0.2,
        timeoutMs: context.timeoutMs,
        timeoutMessage,
        trace,
        eventBase,
    });
    if (!text) {
        logWarn(emptyEvent, {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 2000),
        });
        return emptyMessage;
    }

    const trimmed = text.trim();
    logInfo(completedEvent, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        elapsedMs: Date.now() - startedAt,
        length: trimmed.length,
        mode,
        outputRawPreview: toPreviewWithLimit(JSON.stringify(result), 1200),
        preview: toPreview(trimmed),
    });
    return trimmed;
}

function assertAiBindingConfigured(aiBinding) {
    if (!aiBinding?.run) {
        throw new Error("Workers AI binding is not configured");
    }
}

export function clampLineText(text) {
    const normalized = text.trim();
    const maxLength = 4500;
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 14)}\n\n[內容已截斷]`;
}

export function buildUserErrorMessage(error, currentDateInfo) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Unsupported reading lookup request")) {
        return "請用像「今天我讀了什麼」、「昨天我讀了什麼」或「4/18 我讀了什麼」這樣的方式查詢。";
    }

    if (message.includes("GitHub file not found")) {
        return "找不到閱讀紀錄檔案，請確認 GitHub 路徑設定。";
    }

    if (message.includes("GitHub authentication failed")) {
        return "目前無法讀取 GitHub 私有內容，請檢查 GitHub Token。";
    }

    if (message.includes("summary timed out")) {
        return "摘要整理逾時，請稍後再試，或改查較短時間範圍。";
    }

    if (message.includes("Workers AI")) {
        return "找到相關日期後，暫時無法完成整理，請稍後再試。";
    }

    if (currentDateInfo) {
        return `目前無法處理這次查詢。今天是 ${currentDateInfo.displayDate} ${currentDateInfo.weekday}，請稍後再試。`;
    }

    return "目前暫時無法處理這個指令，請稍後再試。";
}

export async function replyToLine(replyToken, text, channelAccessToken) {
    if (!channelAccessToken) {
        throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
    }

    const startedAt = Date.now();
    const response = await fetch(LINE_REPLY_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify({
            replyToken,
            messages: [{ type: "text", text }],
        }),
    });
    logInfo("line.reply_response", {
        status: response.status,
        replyLength: text.length,
        elapsedMs: Date.now() - startedAt,
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `LINE reply failed with status ${response.status}: ${body}`,
        );
    }
}

export {
    buildDateVariants,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
};
