import { Hono } from "hono";
import { extractAiText, extractSummaryReplyFromResult } from "./ai/response.js";
import {
    DEFAULT_SCHEDULED_QUERY,
    getRuntimeConfig,
    getScheduledDate,
    maskLineUserId,
    requireLineTargetUserId,
} from "./config/runtime.js";
import { fetchGithubFile } from "./github/client.js";
import {
    buildDateVariants,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
} from "./knowledge.js";
import { logError, logInfo, logWarn, toPreview } from "./logger.js";
import { buildLineQueryReply } from "./flows/query-flow.js";
import {
    buildDateInfoFromIsoDate,
    detectReadingLookupDateFromText,
    getCurrentDateInfo,
    timingSafeEqual,
    verifyLineSignature,
} from "./flows/date-query.js";
import { pushToLineUser, replyToLine } from "./line/client.js";
import { buildUserErrorMessage, clampLineText } from "./line/messages.js";

export { extractAiText, extractSummaryReplyFromResult, fetchGithubFile };
export {
    buildDateInfoFromIsoDate,
    buildDateVariants,
    buildUserErrorMessage,
    clampLineText,
    detectReadingLookupDateFromText,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    getCurrentDateInfo,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
    timingSafeEqual,
    verifyLineSignature,
};

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

    const processing = Promise.all(
        events.map((event, index) =>
            handleLineEvent(event, c.env, {
                requestId,
                eventIndex: index,
                totalEvents: events.length,
            }),
        ),
    )
        .then(() => {
            logInfo("webhook.completed", {
                requestId,
                elapsedMs: Date.now() - startedAt,
            });
        })
        .catch((error) => {
            logError("webhook.failed", { requestId }, error);
        });

    c.executionCtx.waitUntil(processing);
    logInfo("webhook.accepted", {
        requestId,
        eventCount: events.length,
        elapsedMs: Date.now() - startedAt,
    });
    return c.text("OK", 200);
});

export const worker = {
    fetch: app.fetch,
    scheduled: handleScheduledSummary,
};

export default worker;

export async function handleLineEvent(event, env, trace = {}) {
    const eventStartedAt = Date.now();
    logInfo("line.event_received", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        totalEvents: trace.totalEvents,
        type: event?.type,
        messageType: event?.message?.type,
        hasReplyToken: Boolean(event?.replyToken),
        sourceType: event?.source?.type || "",
        sourceUserIdPreview: maskLineUserId(event?.source?.userId || ""),
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
        currentDateInfo = getCurrentDateInfo(config.timezone);
        const lineEventTimeoutMs = config.summaryTimeoutMs;
        logInfo("line.runtime_config_loaded", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            githubOwner: config.githubOwner,
            githubRepo: config.githubRepo,
            githubRef: config.githubRef,
            timezone: config.timezone,
            summaryAiModel: config.summaryAiModel,
            summaryTimeoutMs: config.summaryTimeoutMs,
        });

        const message = await withTimeout(
            buildLineQueryReply({
                text,
                env,
                config,
                currentDateInfo,
                trace,
                eventPrefix: "line",
                totalStartedAt: eventStartedAt,
            }),
            lineEventTimeoutMs,
            "LINE event processing timed out",
        );
        logInfo("line.reply_content", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            replyPreview: toPreview(message),
            replyLength: message.length,
        });
        logInfo("line.reply_ready", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            replyLength: message.length,
            totalElapsedMs: Date.now() - eventStartedAt,
        });
        await respondToLineEvent(
            event,
            message,
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
        logInfo("line.reply_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            totalElapsedMs: Date.now() - eventStartedAt,
        });
        return;
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
        try {
            await respondToLineEvent(
                event,
                fallbackMessage,
                env.LINE_CHANNEL_ACCESS_TOKEN,
            );
            logInfo("line.reply_fallback_completed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                replyLength: fallbackMessage.length,
                totalElapsedMs: Date.now() - eventStartedAt,
            });
            return;
        } catch (replyError) {
            logError(
                "line.reply_fallback_failed",
                {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    totalElapsedMs: Date.now() - eventStartedAt,
                },
                replyError,
            );
            throw replyError;
        }
    }
}

async function respondToLineEvent(event, text, channelAccessToken) {
    const sourceUserId = String(event?.source?.userId || "").trim();
    if (sourceUserId) {
        return pushToLineUser(sourceUserId, text, channelAccessToken);
    }
    return replyToLine(event.replyToken, text, channelAccessToken);
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        }),
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

export async function handleScheduledSummary(controller, env) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let currentDateInfo = null;
    let targetUserId = "";
    let pushAttempted = false;

    try {
        const config = getRuntimeConfig(env);
        currentDateInfo = getCurrentDateInfo(
            config.timezone,
            getScheduledDate(controller),
        );
        targetUserId = requireLineTargetUserId(config);
        logInfo("scheduled.received", {
            requestId,
            cron: String(controller?.cron || ""),
            scheduledTime: controller?.scheduledTime || 0,
            targetUserIdPreview: maskLineUserId(targetUserId),
            currentDate: currentDateInfo.isoDate,
        });
        logInfo("scheduled.runtime_config_loaded", {
            requestId,
            githubOwner: config.githubOwner,
            githubRepo: config.githubRepo,
            githubRef: config.githubRef,
            timezone: config.timezone,
            summaryAiModel: config.summaryAiModel,
            summaryTimeoutMs: config.summaryTimeoutMs,
        });

        const message = await buildLineQueryReply({
            text: DEFAULT_SCHEDULED_QUERY,
            env,
            config,
            currentDateInfo,
            trace: { requestId, eventIndex: 0 },
            eventPrefix: "scheduled",
            totalStartedAt: startedAt,
        });

        logInfo("scheduled.reply_content", {
            requestId,
            replyPreview: toPreview(message),
            replyLength: message.length,
        });

        pushAttempted = true;
        try {
            await pushToLineUser(
                targetUserId,
                message,
                env.LINE_CHANNEL_ACCESS_TOKEN,
            );
        } catch (pushError) {
            if (
                pushError instanceof Error &&
                /LINE push failed with status 400/i.test(pushError.message)
            ) {
                const fallbackMessage = clampLineText(
                    buildUserErrorMessage(pushError, currentDateInfo),
                );
                await pushToLineUser(
                    targetUserId,
                    fallbackMessage,
                    env.LINE_CHANNEL_ACCESS_TOKEN,
                );
                logInfo("scheduled.push_retry_completed", {
                    requestId,
                    replyLength: fallbackMessage.length,
                    totalElapsedMs: Date.now() - startedAt,
                });
            } else {
                throw pushError;
            }
        }
        logInfo("scheduled.push_completed", {
            requestId,
            replyLength: message.length,
            totalElapsedMs: Date.now() - startedAt,
        });
    } catch (error) {
        logError(
            "scheduled.handle_failed",
            {
                requestId,
                totalElapsedMs: Date.now() - startedAt,
            },
            error,
        );

        if (!pushAttempted && currentDateInfo && targetUserId) {
            const fallbackMessage = clampLineText(
                buildUserErrorMessage(error, currentDateInfo),
            );
            try {
                await pushToLineUser(
                    targetUserId,
                    fallbackMessage,
                    env.LINE_CHANNEL_ACCESS_TOKEN,
                );
                logInfo("scheduled.push_fallback_completed", {
                    requestId,
                    replyLength: fallbackMessage.length,
                    totalElapsedMs: Date.now() - startedAt,
                });
            } catch (pushError) {
                logError(
                    "scheduled.push_fallback_failed",
                    { requestId },
                    pushError,
                );
            }
        }

        throw error;
    }
}
