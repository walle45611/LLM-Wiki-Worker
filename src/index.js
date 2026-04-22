import { Hono } from "hono";
import { extractAiText, extractSummaryReplyFromResult } from "./ai/response.js";
import {
    buildDateInfoFromIsoDate,
    detectReadingLookupDateFromText,
    getCurrentDateInfo,
} from "./date.js";
import {
    buildScheduledQuery,
    getRuntimeConfig,
    getScheduledDate,
    maskChatId,
    requireTelegramChatId,
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
import { runQueryAgent } from "./flows/query-agent.js";
import { buildUserErrorMessage, clampChatText } from "./chat/messages.js";
import {
    createTelegramWebhookHandler,
    sendTelegramMessage,
} from "./telegram/client.js";

export { extractAiText, extractSummaryReplyFromResult, fetchGithubFile };
export {
    buildDateInfoFromIsoDate,
    buildDateVariants,
    buildUserErrorMessage,
    clampChatText,
    detectReadingLookupDateFromText,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    getCurrentDateInfo,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
    runQueryAgent,
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
    logInfo("webhook.received", {
        requestId,
        bodyLength: bodyText.length,
    });

    let payload = null;
    try {
        payload = JSON.parse(bodyText);
    } catch (error) {
        logWarn("webhook.invalid_payload", {
            requestId,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        return c.text("Bad Request", 400);
    }

    logInfo("webhook.parsed", {
        requestId,
        updateId: payload?.update_id || 0,
        hasMessage: Boolean(payload?.message),
    });

    const handler = createTelegramWebhookHandler(c.env, {
        requestId,
        eventIndex: 0,
    });
    const response = await handler(c);
    logInfo("webhook.completed", {
        requestId,
        elapsedMs: Date.now() - startedAt,
    });
    return response;
});

export const worker = {
    fetch: app.fetch,
    scheduled: handleScheduledSummary,
    queue: handleQueryQueue,
};

export default worker;

export async function handleQueryQueue(batch, env) {
    for (const message of batch.messages) {
        const job = message.body || {};
        if (!["telegram_text_query", "scheduled_summary"].includes(job.type)) {
            logWarn("queue.unknown_job_type", {
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
            const userPrompt = String(job.text || "").trim();
            const chatId = String(job.chatId || "").trim();
            if (!userPrompt || !chatId) {
                throw new Error("Invalid queue payload: missing text or chatId");
            }

            const eventPrefix =
                job.type === "scheduled_summary"
                    ? "scheduled_queue"
                    : "telegram_queue";
            logInfo(`${eventPrefix}.user_query`, {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                textPreview: toPreview(userPrompt),
                currentDate: currentDateInfo.isoDate,
            });
            logInfo(`${eventPrefix}.agent_timeout_selected`, {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                timeoutMs: config.eventTimeoutMs,
            });

            const rawReply = await runQueryAgent({
                userPrompt,
                aiBinding: env.AI,
                aiModel: config.aiModel,
                config,
                trace,
                timeoutMs: config.eventTimeoutMs,
                currentDateInfo,
            });
            const reply = clampChatText(rawReply);
            logInfo(`${eventPrefix}.summary_generated`, {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                summaryLength: rawReply.length,
                summaryPreview: toPreview(rawReply),
                replyLength: reply.length,
                totalElapsedMs: Date.now() - startedAt,
                currentDate: currentDateInfo.isoDate,
            });

            await sendTelegramMessage(
                chatId,
                reply,
                config.telegramBotToken,
            );
            logInfo(
                job.type === "scheduled_summary"
                    ? "scheduled.queue_job_completed"
                    : "telegram.queue_job_completed",
                {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    chatIdPreview: maskChatId(chatId),
                    replyLength: reply.length,
                    totalElapsedMs: Date.now() - startedAt,
                },
            );
            message.ack();
        } catch (error) {
            logError(
                job.type === "scheduled_summary"
                    ? "scheduled.queue_job_failed"
                    : "telegram.queue_job_failed",
                {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    totalElapsedMs: Date.now() - startedAt,
                },
                error,
            );

            const fallbackMessage = clampChatText(
                buildUserErrorMessage(error, currentDateInfo),
            );
            const chatId = String(job.chatId || "").trim();
            if (chatId) {
                try {
                    const config = getRuntimeConfig(env);
                    await sendTelegramMessage(
                        chatId,
                        fallbackMessage,
                        config.telegramBotToken,
                    );
                    logInfo(
                        job.type === "scheduled_summary"
                            ? "scheduled.queue_job_fallback_pushed"
                            : "telegram.queue_job_fallback_pushed",
                        {
                            requestId: trace.requestId,
                            eventIndex: trace.eventIndex,
                            chatIdPreview: maskChatId(chatId),
                            replyLength: fallbackMessage.length,
                            totalElapsedMs: Date.now() - startedAt,
                        },
                    );
                } catch (pushError) {
                    logError(
                        job.type === "scheduled_summary"
                            ? "scheduled.queue_job_fallback_failed"
                            : "telegram.queue_job_fallback_failed",
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
        const currentDateInfo = getCurrentDateInfo(
            config.timezone,
            scheduledDate,
        );
        const chatId = requireTelegramChatId(config);
        const text = buildScheduledQuery(currentDateInfo);
        logInfo("scheduled.received", {
            requestId,
            cron: String(controller?.cron || ""),
            scheduledTime: controller?.scheduledTime || 0,
            chatIdPreview: maskChatId(chatId),
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
            chatId,
            scheduledTime: scheduledDate.getTime(),
            queuedAt: Date.now(),
        });

        logInfo("scheduled.enqueued", {
            requestId,
            chatIdPreview: maskChatId(chatId),
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
