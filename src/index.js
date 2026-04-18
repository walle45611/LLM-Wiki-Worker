import { Hono } from "hono";
import {
    buildDateResolutionAssistantPrompt,
    buildDateResolutionSystemPrompt,
    buildDateResolutionUserPrompt,
    buildSummarySystemPrompt,
    buildSummaryUserPrompt,
} from "./prompts.js";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const GITHUB_API_BASE = "https://api.github.com";

export const app = new Hono();

app.onError((error) => {
    console.error("Unhandled worker error", error);
    return new Response("Internal Server Error", { status: 500 });
});

app.get("/", (c) => c.json({ ok: true, service: "llmwikiworker" }));

app.post("/webhook", async (c) => {
    const bodyText = await c.req.text();
    const signature = c.req.header("x-line-signature");
    console.log("[webhook] received", {
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
        console.warn("[webhook] signature verification failed");
        return c.text("Unauthorized", 401);
    }

    const payload = JSON.parse(bodyText);
    const events = Array.isArray(payload.events) ? payload.events : [];
    console.log("[webhook] parsed payload", { eventCount: events.length });
    await Promise.all(events.map((event) => handleLineEvent(event, c.env)));

    return c.text("OK", 200);
});

export default app;

export async function handleLineEvent(event, env) {
    console.log("[line] handling event", {
        type: event?.type,
        messageType: event?.message?.type,
        hasReplyToken: Boolean(event?.replyToken),
    });

    if (
        !event?.replyToken ||
        event.replyToken === "00000000000000000000000000000000"
    ) {
        console.warn("[line] skip event without valid reply token");
        return;
    }

    if (event.type !== "message" || event.message?.type !== "text") {
        console.log("[line] unsupported message type");
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
        console.log("[line] runtime config loaded", {
            githubOwner: config.githubOwner,
            githubRepo: config.githubRepo,
            githubRef: config.githubRef,
            githubLogPath: config.githubLogPath,
            githubIndexPath: config.githubIndexPath,
            githubAgentsPath: config.githubAgentsPath,
            githubQueryRulesPath: config.githubQueryRulesPath,
            timezone: config.timezone,
            aiModel: config.aiModel,
        });

        currentDateInfo = getCurrentDateInfo(config.timezone);
        console.log("[line] user query", {
            text,
            currentDate: currentDateInfo.isoDate,
        });
        const targetDateInfo = await resolveTargetDate(
            text,
            currentDateInfo,
            env.AI,
            config.aiModel,
        );
        console.log("[line] resolved target date", {
            isoDate: targetDateInfo.isoDate,
            displayDate: targetDateInfo.displayDate,
            weekday: targetDateInfo.weekday,
        });

        const [logContent, indexContent, agentsContent, queryRulesContent] =
            await Promise.all([
                fetchGithubFile(config, config.githubLogPath),
                fetchGithubFile(config, config.githubIndexPath),
                fetchGithubFile(config, config.githubAgentsPath),
                fetchGithubFile(config, config.githubQueryRulesPath),
            ]);
        console.log("[line] fetched knowledge files", {
            logLength: logContent.length,
            indexLength: indexContent.length,
            agentsLength: agentsContent.length,
            queryRulesLength: queryRulesContent.length,
        });

        const resolution = resolveSummaryPathsForDate(
            logContent,
            indexContent,
            targetDateInfo,
        );
        console.log("[line] resolved summary paths", {
            total: resolution.summaryPaths.length,
            unresolvedCount: resolution.unresolvedReferences.length,
        });

        if (resolution.summaryPaths.length === 0) {
            return replyToLine(
                event.replyToken,
                `${targetDateInfo.displayDate} 沒有可摘要的 summaries 紀錄。`,
                env.LINE_CHANNEL_ACCESS_TOKEN,
            );
        }

        const summarySources = await fetchSummaryFiles(
            config,
            resolution.summaryPaths,
        );
        console.log("[line] fetched summary files", {
            requested: resolution.summaryPaths.length,
            found: summarySources.files.length,
            missing: summarySources.missingPaths.length,
        });

        if (summarySources.files.length === 0) {
            return replyToLine(
                event.replyToken,
                `${targetDateInfo.displayDate} 有紀錄，但找不到可讀取的 summary 內容。`,
                env.LINE_CHANNEL_ACCESS_TOKEN,
            );
        }

        const summary = await summarizeReadingLog(
            summarySources.files,
            currentDateInfo,
            targetDateInfo,
            env.AI,
            config.aiModel,
            {
                agentsContent,
                queryRulesContent,
                unresolvedReferences: [
                    ...resolution.unresolvedReferences,
                    ...summarySources.missingPaths,
                ],
            },
        );
        const message = clampLineText(summary);
        console.log("[line] summary generated", {
            summaryLength: summary.length,
            replyLength: message.length,
        });
        return replyToLine(
            event.replyToken,
            message,
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    } catch (error) {
        console.error("Failed to handle LINE command", error);
        const fallbackMessage = buildUserErrorMessage(error, currentDateInfo);
        return replyToLine(
            event.replyToken,
            fallbackMessage,
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }
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
        githubAgentsPath: env.GITHUB_AGENTS_PATH || "AGENTS.md",
        githubQueryRulesPath:
            env.GITHUB_QUERY_RULES_PATH || "wiki/rules/query-rules.md",
        githubToken: env.GITHUB_TOKEN,
        timezone: env.APP_TIMEZONE || "Asia/Taipei",
        aiModel: env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct",
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

export async function fetchGithubFile(config, filePath) {
    const encodedPath = filePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(config.githubRef)}`;
    console.log("[github] fetching file", {
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: config.githubRef,
        path: filePath,
    });

    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${config.githubToken}`,
            "User-Agent": "llmwikiworker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    console.log("[github] response", { status: response.status });

    if (response.status === 404) {
        throw new Error(`GitHub file not found: ${filePath}`);
    }

    if (response.status === 401 || response.status === 403) {
        throw new Error("GitHub authentication failed");
    }

    if (!response.ok) {
        throw new Error(`GitHub API failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.content) {
        throw new Error("GitHub API returned empty file content");
    }

    const normalized = payload.content.replace(/\n/g, "");
    const bytes = Uint8Array.from(atob(normalized), (char) =>
        char.charCodeAt(0),
    );
    const decoded = new TextDecoder().decode(bytes);
    console.log("[github] decoded content", { length: decoded.length });
    return decoded;
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

export function pad2(value) {
    return String(value).padStart(2, "0");
}

export function extractLogForDate(logContent, dateInfo) {
    const variants = buildDateVariants(dateInfo);
    const lines = logContent.split(/\r?\n/);
    const blocks = [];
    const seen = new Set();
    const genericDateLine =
        /^(\s{0,3}#{1,6}\s*)?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!lineMatchesVariants(line, variants)) {
            continue;
        }

        const blockLines = [line];
        let blankCount = 0;

        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const nextLine = lines[cursor];
            const trimmed = nextLine.trim();

            if (
                genericDateLine.test(trimmed) &&
                !lineMatchesVariants(nextLine, variants)
            ) {
                break;
            }

            if (
                /^\s*#{1,6}\s+/.test(trimmed) &&
                !lineMatchesVariants(nextLine, variants)
            ) {
                break;
            }

            blockLines.push(nextLine);

            if (trimmed === "") {
                blankCount += 1;
                if (blankCount >= 2) {
                    break;
                }
            } else {
                blankCount = 0;
            }
        }

        const block = blockLines.join("\n").trim();
        if (block && !seen.has(block)) {
            blocks.push(block);
            seen.add(block);
        }
    }

    if (blocks.length > 0) {
        return blocks.join("\n\n");
    }

    return extractParagraphMatches(logContent, variants);
}

export function extractLogBlocksForDate(logContent, dateInfo) {
    const variants = buildDateVariants(dateInfo);
    const lines = logContent.split(/\r?\n/);
    const blocks = [];
    let currentHeader = null;
    let currentLines = [];

    for (const line of lines) {
        if (/^\s*##\s+/.test(line)) {
            if (currentHeader && lineMatchesVariants(currentHeader, variants)) {
                blocks.push([currentHeader, ...currentLines].join("\n").trim());
            }
            currentHeader = line;
            currentLines = [];
            continue;
        }

        if (currentHeader) {
            currentLines.push(line);
        }
    }

    if (currentHeader && lineMatchesVariants(currentHeader, variants)) {
        blocks.push([currentHeader, ...currentLines].join("\n").trim());
    }

    return blocks.filter(Boolean);
}

export function parsePathList(value) {
    const inlineCodeMatches = [...value.matchAll(/`([^`]+)`/g)].map(
        (match) => match[1],
    );
    if (inlineCodeMatches.length > 0) {
        return inlineCodeMatches;
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function extractSummaryReferencesFromLog(logContent, dateInfo) {
    const blocks = extractLogBlocksForDate(logContent, dateInfo);
    const references = [];

    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*-\s*(created|updated)\s*:\s*(.+)$/i);
            if (!match) {
                continue;
            }
            references.push(...parsePathList(match[2]));
        }
    }

    return references;
}

export function normalizeWikiPath(rawPath) {
    const cleaned = rawPath.trim().replace(/^['"`]|['"`]$/g, "");
    const slashNormalized = cleaned.replace(/\\/g, "/");
    const wikiIndex = slashNormalized.indexOf("wiki/");
    if (wikiIndex >= 0) {
        return slashNormalized.slice(wikiIndex);
    }

    if (slashNormalized.startsWith("./")) {
        return slashNormalized.slice(2);
    }

    if (slashNormalized.startsWith("/")) {
        return slashNormalized.slice(1);
    }

    return slashNormalized;
}

export function parseSummaryIndex(indexContent) {
    const lines = indexContent.split(/\r?\n/);
    let inSummariesSection = false;
    const mapping = new Map();

    for (const line of lines) {
        if (/^\s*##\s+Summaries\s*$/i.test(line)) {
            inSummariesSection = true;
            continue;
        }

        if (/^\s*##\s+/.test(line) && !/^\s*##\s+Summaries\s*$/i.test(line)) {
            inSummariesSection = false;
            continue;
        }

        if (!inSummariesSection) {
            continue;
        }

        const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (!linkMatch) {
            continue;
        }

        const slug = linkMatch[1].trim().toLowerCase();
        const path = normalizeWikiPath(linkMatch[2]);
        if (path.includes("wiki/summaries/") && path.endsWith(".md")) {
            mapping.set(slug, path);
        }
    }

    return mapping;
}

export function resolveSummaryPathsForDate(logContent, indexContent, dateInfo) {
    const references = extractSummaryReferencesFromLog(logContent, dateInfo);
    const indexMap = parseSummaryIndex(indexContent);
    const summaryPaths = new Set();
    const unresolvedReferences = [];

    for (const reference of references) {
        const normalized = normalizeWikiPath(reference);
        const lowered = normalized.toLowerCase();

        if (lowered.startsWith("wiki/summaries/") && lowered.endsWith(".md")) {
            summaryPaths.add(normalized);
            continue;
        }

        const slug = lowered.replace(/\.md$/, "").split("/").pop();
        const fromIndex = slug ? indexMap.get(slug) : null;
        if (fromIndex) {
            summaryPaths.add(fromIndex);
            continue;
        }

        unresolvedReferences.push(reference);
    }

    return {
        summaryPaths: Array.from(summaryPaths),
        unresolvedReferences,
    };
}

export async function fetchSummaryFiles(config, paths) {
    const files = [];
    const missingPaths = [];

    await Promise.all(
        paths.map(async (path) => {
            try {
                const content = await fetchGithubFile(config, path);
                files.push({ path, content });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                if (message.includes("GitHub file not found")) {
                    missingPaths.push(path);
                    return;
                }
                throw error;
            }
        }),
    );

    return { files, missingPaths };
}

export function buildDateVariants(dateInfo) {
    return [
        `${dateInfo.year}-${pad2(dateInfo.month)}-${pad2(dateInfo.day)}`,
        `${dateInfo.year}-${dateInfo.month}-${dateInfo.day}`,
        `${dateInfo.year}/${pad2(dateInfo.month)}/${pad2(dateInfo.day)}`,
        `${dateInfo.year}/${dateInfo.month}/${dateInfo.day}`,
        `${dateInfo.year}.${pad2(dateInfo.month)}.${pad2(dateInfo.day)}`,
        `${dateInfo.year}.${dateInfo.month}.${dateInfo.day}`,
        `${dateInfo.year}年${dateInfo.month}月${dateInfo.day}日`,
        `${dateInfo.year}年${pad2(dateInfo.month)}月${pad2(dateInfo.day)}日`,
    ];
}

export function lineMatchesVariants(line, variants) {
    return variants.some((variant) => line.includes(variant));
}

export function extractParagraphMatches(logContent, variants) {
    const sections = logContent.split(/\n{2,}/);
    const matches = sections.filter((section) =>
        lineMatchesVariants(section, variants),
    );
    return matches.join("\n\n").trim();
}

export async function resolveTargetDate(
    userText,
    currentDateInfo,
    aiBinding,
    aiModel,
) {
    if (!aiBinding?.run) {
        throw new Error("Workers AI binding is not configured");
    }

    console.log("[ai] resolving target date", {
        model: aiModel,
        currentDate: currentDateInfo.isoDate,
        userText,
    });
    const result = await aiBinding.run(aiModel, {
        messages: [
            {
                role: "system",
                content: buildDateResolutionSystemPrompt(currentDateInfo),
            },
            {
                role: "user",
                content: buildDateResolutionUserPrompt(userText),
            },
            {
                role: "assistant",
                content: buildDateResolutionAssistantPrompt(),
            },
        ],
    });

    const text = extractAiText(result);
    console.log("[ai] date resolution raw output", {
        length: text.length,
        preview: text.slice(0, 200),
    });
    const parsed = parseDateResolution(text);

    if (parsed.intent !== "reading_lookup" || !parsed.date) {
        throw new Error("Unsupported reading lookup request");
    }

    return buildDateInfoFromIsoDate(parsed.date, currentDateInfo.timezone);
}

export function parseDateResolution(text) {
    const trimmed = text.trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");

    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        throw new Error("Workers AI returned an invalid date resolution payload");
    }

    const candidate = trimmed.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(candidate);

    if (
        parsed.intent === "reading_lookup" &&
        !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date || "")
    ) {
        throw new Error("Workers AI returned an invalid date format");
    }

    return parsed;
}

export async function summarizeReadingLog(
    summaryFiles,
    currentDateInfo,
    targetDateInfo,
    aiBinding,
    aiModel,
    context,
) {
    if (!aiBinding?.run) {
        throw new Error("Workers AI binding is not configured");
    }

    console.log("[ai] summarizing reading log", {
        model: aiModel,
        summaryFileCount: summaryFiles.length,
        currentDate: currentDateInfo.isoDate,
        targetDate: targetDateInfo.isoDate,
        agentsLength: context.agentsContent.length,
        queryRulesLength: context.queryRulesContent.length,
        unresolvedCount: context.unresolvedReferences.length,
    });
    const result = await aiBinding.run(aiModel, {
        messages: [
            {
                role: "system",
                content: buildSummarySystemPrompt(
                    currentDateInfo,
                    context.agentsContent,
                    context.queryRulesContent,
                ),
            },
            {
                role: "user",
                content: buildSummaryUserPrompt(
                    summaryFiles,
                    targetDateInfo,
                    context.unresolvedReferences,
                ),
            },
        ],
    });

    const text = extractAiText(result);
    if (!text) {
        throw new Error("Workers AI returned an empty summary");
    }

    const trimmed = text.trim();
    console.log("[ai] summary output", { length: trimmed.length });
    return trimmed;
}

export function extractAiText(result) {
    if (!result) {
        return "";
    }

    if (typeof result === "string") {
        return result;
    }

    if (typeof result.response === "string") {
        return result.response;
    }

    if (typeof result.output_text === "string") {
        return result.output_text;
    }

    if (Array.isArray(result.result?.messages)) {
        const joined = result.result.messages
            .map((message) => message?.content)
            .filter(Boolean)
            .join("\n");
        if (joined) {
            return joined;
        }
    }

    if (Array.isArray(result.choices)) {
        const joined = result.choices
            .map((choice) => choice?.message?.content || choice?.text)
            .filter(Boolean)
            .join("\n");
        if (joined) {
            return joined;
        }
    }

    return "";
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
    console.log("[line] reply response", {
        status: response.status,
        replyLength: text.length,
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `LINE reply failed with status ${response.status}: ${body}`,
        );
    }
}
