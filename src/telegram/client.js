import { Bot, webhookCallback } from "grammy";
import { maskChatId } from "../config/runtime.js";
import { logInfo } from "../logger.js";
import { clampChatText } from "../chat/messages.js";
import {
    renderTelegramMessage,
    renderTelegramMessageAsPlainText,
} from "./renderer.js";

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

export async function sendTelegramMessage(
    chatId,
    content,
    botToken,
    clientOptions,
) {
    if (!botToken) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN");
    }
    if (!chatId) {
        throw new Error("Missing Telegram chat id");
    }

    const bot = clientOptions
        ? new Bot(botToken, { client: clientOptions })
        : new Bot(botToken);
    const startedAt = Date.now();
    const { text, entities } = toTelegramMessage(content);
    let response = null;

    try {
        response = await bot.api.sendMessage(
            chatId,
            text,
            buildSendOptions(entities),
        );
    } catch (error) {
        if (!isTelegramEntityParseError(error)) {
            throw error;
        }

        logInfo("telegram.send_message_entities_fallback", {
            chatIdPreview: maskChatId(chatId),
            messageLength: text.length,
            errorMessage: error instanceof Error ? error.message : String(error),
        });

        response = await bot.api.sendMessage(chatId, text, {
            link_preview_options: {
                is_disabled: true,
            },
        });
    }

    logInfo("telegram.send_message_completed", {
        chatIdPreview: maskChatId(chatId),
        messageLength: text.length,
        entityCount: entities.length,
        messageId: response.message_id,
        elapsedMs: Date.now() - startedAt,
    });
}

function buildSendOptions(entities) {
    const linkPreview = {
        link_preview_options: {
            is_disabled: true,
        },
    };
    if (!Array.isArray(entities) || entities.length === 0) {
        return linkPreview;
    }
    return {
        ...linkPreview,
        entities,
    };
}

function toTelegramMessage(content) {
    if (typeof content === "string") {
        return {
            text: clampChatText(content),
            entities: [],
        };
    }
    if (!content || typeof content !== "object") {
        throw new Error("Telegram message content is invalid");
    }

    if (Array.isArray(content.blocks)) {
        try {
            const rendered = renderTelegramMessage(content);
            const clamped = clampChatText(rendered.text);
            return {
                text: clamped,
                entities: clamped === rendered.text ? rendered.entities || [] : [],
            };
        } catch {
            const fallbackText = renderTelegramMessageAsPlainText(content);
            return {
                text: clampChatText(fallbackText),
                entities: [],
            };
        }
    }

    throw new Error("Telegram message content must be text or blocks payload");
}

function isTelegramEntityParseError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("can't parse entities") ||
        message.includes("can't find end of") ||
        message.includes("Bad Request: can't parse")
    );
}
