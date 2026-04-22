import { Bot, webhookCallback } from "grammy";
import { maskChatId } from "../config/runtime.js";
import { logInfo } from "../logger.js";
import { buildTelegramMessage } from "../chat/messages.js";

export function createTelegramWebhookHandler(env, trace = {}) {
    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

    bot.on("message:text", async (ctx) => {
        const text = ctx.message.text.trim();
        const chatId = String(ctx.chat?.id || "").trim();

        logInfo("telegram.event_received", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            updateId: ctx.update.update_id,
            chatIdPreview: maskChatId(chatId),
            textPreview: text,
        });

        if (!chatId || !text) {
            logInfo("telegram.event_ignored", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                updateId: ctx.update.update_id,
                hasChatId: Boolean(chatId),
                hasText: Boolean(text),
            });
            return;
        }

        await env.LLM_WIKI_QUEUE.send({
            type: "telegram_text_query",
            requestId: trace.requestId || crypto.randomUUID(),
            eventIndex: trace.eventIndex ?? 0,
            text,
            chatId,
            queuedAt: Date.now(),
        });
        logInfo("telegram.queue_enqueued", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            updateId: ctx.update.update_id,
            chatIdPreview: maskChatId(chatId),
            textPreview: text,
        });
    });

    bot.catch((error) => {
        logInfo("telegram.bot_error", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            errorMessage:
                error.error instanceof Error
                    ? error.error.message
                    : String(error.error),
        });
    });

    return webhookCallback(bot, "hono");
}

export async function sendTelegramMessage(chatId, text, botToken) {
    if (!botToken) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN");
    }
    if (!chatId) {
        throw new Error("Missing Telegram chat id");
    }

    const bot = new Bot(botToken);
    const startedAt = Date.now();
    const message = buildTelegramMessage(text);
    const response = await bot.api.sendMessage(chatId, message, {
        parse_mode: "MarkdownV2",
        link_preview_options: {
            is_disabled: true,
        },
    });

    logInfo("telegram.send_message_completed", {
        chatIdPreview: maskChatId(chatId),
        messageLength: message.length,
        messageId: response.message_id,
        elapsedMs: Date.now() - startedAt,
    });
}
