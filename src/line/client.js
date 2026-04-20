import { logInfo } from "../logger.js";
import {
    LINE_PUSH_ENDPOINT,
    LINE_REPLY_ENDPOINT,
    maskLineUserId,
} from "../config/runtime.js";
import { clampLineText } from "./messages.js";

export async function replyToLine(replyToken, text, channelAccessToken) {
    if (!channelAccessToken) {
        throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
    }

    const normalizedText = normalizeLineText(text);
    const startedAt = Date.now();
    const response = await fetch(LINE_REPLY_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify({
            replyToken,
            messages: [{ type: "text", text: normalizedText }],
        }),
    });
    logInfo("line.reply_response", {
        status: response.status,
        replyLength: normalizedText.length,
        elapsedMs: Date.now() - startedAt,
        replyPreview: normalizedText.slice(0, 500),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `LINE reply failed with status ${response.status}: ${body}`,
        );
    }
}

export async function pushToLineUser(userId, text, channelAccessToken) {
    if (!channelAccessToken) {
        throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");
    }
    if (!userId) {
        throw new Error("Missing LINE target user id");
    }

    const normalizedText = normalizeLineText(text);
    const startedAt = Date.now();
    const response = await fetch(LINE_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${channelAccessToken}`,
        },
        body: JSON.stringify({
            to: userId,
            messages: [{ type: "text", text: normalizedText }],
        }),
    });
    logInfo("line.push_response", {
        status: response.status,
        targetUserIdPreview: maskLineUserId(userId),
        replyLength: normalizedText.length,
        elapsedMs: Date.now() - startedAt,
        replyPreview: normalizedText.slice(0, 500),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `LINE push failed with status ${response.status}: ${body}`,
        );
    }
}

function normalizeLineText(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
        return "目前暫時無法提供內容，請稍後再試。";
    }
    return clampLineText(trimmed);
}
