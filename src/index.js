import { Hono } from "hono";
import { extractAiText, extractSummaryReplyFromResult } from "./ai/response.js";
import {
    buildScheduledQuery,
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

    await Promise.all(
        events.map((event, index) =>
            handleLineEvent(event, c.env, {
                requestId,
                eventIndex: index,
                totalEvents: events.length,
            }),
        ),
    );
    logInfo("webhook.completed", {
        requestId,
        elapsedMs: Date.now() - startedAt,
    });
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
    queue: handleLineQueryQueue,
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
    const sourceUserId = String(event?.source?.userId || "").trim();
    if (!sourceUserId) {
        logWarn("line.queue_missing_user_id", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
        });
        return replyToLine(
            event.replyToken,
            "目前僅支援一對一聊天查詢。",
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
    }

    try {
        const config = getRuntimeConfig(env);
        logInfo("line.queue_runtime_config_loaded", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            githubOwner: config.githubOwner,
            githubRepo: config.githubRepo,
            githubRef: config.githubRef,
            timezone: config.timezone,
            aiModel: config.aiModel,
            eventTimeoutMs: config.eventTimeoutMs,
        });
        await env.LLM_WIKI_QUEUE.send({
            type: "line_text_query",
            requestId: trace.requestId || crypto.randomUUID(),
            eventIndex: trace.eventIndex ?? 0,
            text,
            sourceUserId,
            queuedAt: Date.now(),
        });
        logInfo("line.queue_enqueued", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            sourceUserIdPreview: maskLineUserId(sourceUserId),
            textPreview: toPreview(text),
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
        const fallbackMessage = "目前系統忙碌，請稍後再試。";
        await replyToLine(
            event.replyToken,
            fallbackMessage,
            env.LINE_CHANNEL_ACCESS_TOKEN,
        );
        logInfo("line.reply_fallback_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            replyLength: fallbackMessage.length,
            totalElapsedMs: Date.now() - eventStartedAt,
        });
    }
}

export async function handleLineQueryQueue(batch, env) {
    for (const message of batch.messages) {
        const job = message.body || {};
        if (!["line_text_query", "scheduled_summary"].includes(job.type)) {
            logWarn("line.queue_unknown_job_type", {
                requestId: job.requestId || "",
                type: String(job.type || ""),
            });
            message.ack();
            continue;
        }

        const startedAt = Date.now();
        const trace = {
            requestId: String(job.requestId || crypto.randomUUID()),
            eventIndex: Number.isFinite(job.eventIndex) ? job.eventIndex : 0,
        };
        let currentDateInfo = null;

        try {
            const config = getRuntimeConfig(env);
            const scheduledTime = Number(job.scheduledTime);
            const currentDate =
                Number.isFinite(scheduledTime) && scheduledTime > 0
                    ? new Date(scheduledTime)
                    : undefined;
            currentDateInfo = getCurrentDateInfo(config.timezone, currentDate);
            const text = String(job.text || "").trim();
            const userId =
                job.type === "scheduled_summary"
                    ? String(job.targetUserId || "").trim()
                    : String(job.sourceUserId || "").trim();
            if (!text || !userId) {
                throw new Error("Invalid queue payload: missing text or sourceUserId");
            }

            const reply = await buildLineQueryReply({
                text,
                env,
                config,
                currentDateInfo,
                trace,
                eventPrefix:
                    job.type === "scheduled_summary"
                        ? "scheduled_queue"
                        : "line_queue",
                totalStartedAt: startedAt,
                timeoutMs: config.eventTimeoutMs,
            });

            await pushToLineUser(userId, reply, env.LINE_CHANNEL_ACCESS_TOKEN);
            logInfo(
                job.type === "scheduled_summary"
                    ? "scheduled.queue_job_completed"
                    : "line.queue_job_completed",
                {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                sourceUserIdPreview: maskLineUserId(userId),
                replyLength: reply.length,
                totalElapsedMs: Date.now() - startedAt,
                },
            );
            message.ack();
        } catch (error) {
            logError(
                job.type === "scheduled_summary"
                    ? "scheduled.queue_job_failed"
                    : "line.queue_job_failed",
                {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    totalElapsedMs: Date.now() - startedAt,
                },
                error,
            );

            const fallbackMessage = clampLineText(
                buildUserErrorMessage(error, currentDateInfo),
            );
            const userId =
                job.type === "scheduled_summary"
                    ? String(job.targetUserId || "").trim()
                    : String(job.sourceUserId || "").trim();
            if (userId) {
                try {
                    await pushToLineUser(userId, fallbackMessage, env.LINE_CHANNEL_ACCESS_TOKEN);
                    logInfo(
                        job.type === "scheduled_summary"
                            ? "scheduled.queue_job_fallback_pushed"
                            : "line.queue_job_fallback_pushed",
                        {
                        requestId: trace.requestId,
                        eventIndex: trace.eventIndex,
                        sourceUserIdPreview: maskLineUserId(userId),
                        replyLength: fallbackMessage.length,
                        totalElapsedMs: Date.now() - startedAt,
                        },
                    );
                } catch (pushError) {
                    logError(
                        job.type === "scheduled_summary"
                            ? "scheduled.queue_job_fallback_failed"
                            : "line.queue_job_fallback_failed",
                        {
                            requestId: trace.requestId,
                            eventIndex: trace.eventIndex,
                        },
                        pushError,
                    );
                }
            }
            message.ack();
        }
    }
}

export async function handleScheduledSummary(controller, env) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();

    try {
        const config = getRuntimeConfig(env);
        const scheduledDate = getScheduledDate(controller);
        const currentDateInfo = getCurrentDateInfo(config.timezone, scheduledDate);
        const targetUserId = requireLineTargetUserId(config);
        const text = buildScheduledQuery(currentDateInfo);
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
            aiModel: config.aiModel,
            eventTimeoutMs: config.eventTimeoutMs,
        });

        await env.LLM_WIKI_QUEUE.send({
            type: "scheduled_summary",
            requestId,
            eventIndex: 0,
            text,
            targetUserId,
            scheduledTime: scheduledDate.getTime(),
            queuedAt: Date.now(),
        });

        logInfo("scheduled.enqueued", {
            requestId,
            targetUserIdPreview: maskLineUserId(targetUserId),
            textPreview: toPreview(text),
            totalElapsedMs: Date.now() - startedAt,
        });
    } catch (error) {
        logError(
            "scheduled.enqueue_failed",
            {
                requestId,
                totalElapsedMs: Date.now() - startedAt,
            },
            error,
        );
        throw error;
    }
}
