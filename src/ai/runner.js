import { logInfo, logWarn } from "../logger.js";
import { extractAiText } from "./response.js";

const DEFAULT_MAX_TOKENS = 4096;

export async function runAiTextGeneration({
    aiBinding,
    aiModel,
    instructions = "",
    messages,
    responseFormat,
    extractText = extractAiText,
    temperature,
    timeoutMs,
    timeoutMessage,
    trace = {},
    eventBase,
}) {
    let primaryResult = null;
    try {
        primaryResult = await runAiOnce({
            aiBinding,
            aiModel,
            instructions,
            messages,
            responseFormat,
            temperature,
            timeoutMs,
            timeoutMessage,
        });
    } catch (error) {
        if (!instructions || !isTimeoutError(error, timeoutMessage)) {
            throw error;
        }
        logWarn(`${eventBase}.primary_timed_out`, {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        return runFallbackGeneration({
            aiBinding,
            aiModel,
            messages,
            responseFormat,
            extractText,
            temperature,
            timeoutMs,
            timeoutMessage,
            trace,
            eventBase,
            mode: "messages_timeout_fallback",
        });
    }
    let text = extractText(primaryResult);
    if (text) {
        return { text, result: primaryResult, mode: "instructions_input" };
    }

    logWarn(`${eventBase}.empty_primary_output`, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        outputRawPreview: toPreviewWithLimit(
            JSON.stringify(primaryResult),
            1200,
        ),
    });

    if (!instructions) {
        return { text, result: primaryResult, mode: "messages" };
    }

    return runFallbackGeneration({
        aiBinding,
        aiModel,
        messages,
        responseFormat,
        extractText,
        temperature,
        timeoutMs,
        timeoutMessage,
        trace,
        eventBase,
        mode: "messages_fallback",
    });
}

async function runFallbackGeneration({
    aiBinding,
    aiModel,
    messages,
    responseFormat,
    extractText,
    temperature,
    timeoutMs,
    timeoutMessage,
    trace,
    eventBase,
    mode,
}) {
    const fallbackResult = await runAiOnce({
        aiBinding,
        aiModel,
        instructions: "",
        messages,
        responseFormat,
        temperature,
        timeoutMs,
        timeoutMessage,
    });
    const text = extractText(fallbackResult);
    logInfo(`${eventBase}.fallback_completed`, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        hasText: Boolean(text),
        outputRawPreview: toPreviewWithLimit(
            JSON.stringify(fallbackResult),
            1200,
        ),
    });
    return { text, result: fallbackResult, mode };
}

async function runAiOnce({
    aiBinding,
    aiModel,
    instructions,
    messages,
    responseFormat,
    temperature,
    timeoutMs,
    timeoutMessage,
}) {
    const payload = {
        ...(instructions ? { instructions } : {}),
        messages,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        max_tokens: DEFAULT_MAX_TOKENS,
        temperature,
    };
    return withTimeout(aiBinding.run(aiModel, payload), timeoutMs, timeoutMessage);
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

function isTimeoutError(error, timeoutMessage) {
    const message = error instanceof Error ? error.message : String(error);
    return message === timeoutMessage;
}

export function buildAiInputLog(messages) {
    return messages.map((message, index) => {
        const text = extractMessageContentText(message.content);
        return {
            index,
            role: message.role,
            contentLength: text.length,
            contentPreview: toPreviewWithLimit(text, 1200),
        };
    });
}

export function toPreviewWithLimit(text, maxLength) {
    const normalized = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
}

function extractMessageContentText(content) {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (!item) {
                    return "";
                }
                if (typeof item === "string") {
                    return item;
                }
                if (typeof item.text === "string") {
                    return item.text;
                }
                return "";
            })
            .join("\n");
    }
    return String(content ?? "");
}
