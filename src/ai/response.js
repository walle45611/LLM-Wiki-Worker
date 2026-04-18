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
    if (Array.isArray(result.response)) {
        const joined = result.response
            .map((item) =>
                typeof item === "string"
                    ? item
                    : item?.text || item?.content || "",
            )
            .filter(Boolean)
            .join("\n");
        if (joined) {
            return joined;
        }
    }
    if (typeof result.output_text === "string") {
        return result.output_text;
    }
    if (typeof result.result === "string") {
        return result.result;
    }
    if (typeof result.result?.response === "string") {
        return result.result.response;
    }
    if (typeof result.message?.content === "string") {
        return result.message.content;
    }

    const outputText =
        extractOutputText(result.output) ||
        extractOutputText(result.result?.output);
    if (outputText) {
        return outputText;
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

export function extractSummaryReplyFromResult(result) {
    const response = result?.response;
    if (
        response &&
        typeof response === "object" &&
        !Array.isArray(response) &&
        typeof response.reply === "string"
    ) {
        return response.reply;
    }
    if (
        response &&
        typeof response === "object" &&
        !Array.isArray(response) &&
        typeof response.response === "string"
    ) {
        return response.response;
    }

    const text = extractAiText(result);
    const parsed = parseReplyPayload(text);
    if (parsed) {
        return parsed.reply;
    }
    return parseSafePlainReply(text);
}

function parseReplyPayload(text) {
    const trimmed = String(text || "").trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        return null;
    }
    try {
        const candidate = trimmed.slice(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(candidate);
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.reply === "string" &&
            parsed.reply.trim()
        ) {
            return parsed;
        }
        if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.response === "string" &&
            parsed.response.trim()
        ) {
            return { reply: parsed.response };
        }
    } catch {
        return null;
    }
    return null;
}

function parseSafePlainReply(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
        return "";
    }

    // Reject obvious malformed / non-answer outputs.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return "";
    }
    if (trimmed.length < 8) {
        return "";
    }
    if (
        /(^|\s)(the user wants|we need to|let's|reasoning|think step by step)/i.test(
            trimmed,
        )
    ) {
        return "";
    }
    if (/^\[[^\]\n]{1,24}\]$/.test(trimmed)) {
        return "";
    }
    if (!/[\u4e00-\u9fff]/.test(trimmed) && trimmed.length < 24) {
        return "";
    }

    // Allow plain final text if it looks like a user-facing reply.
    return trimmed;
}

function extractOutputText(output) {
    if (!Array.isArray(output)) {
        return "";
    }
    const chunks = [];
    for (const item of output) {
        if (typeof item?.text === "string") {
            chunks.push(item.text);
        }
        if (typeof item?.content === "string") {
            chunks.push(item.content);
        }
        if (Array.isArray(item?.content)) {
            for (const part of item.content) {
                if (typeof part === "string") {
                    chunks.push(part);
                } else if (typeof part?.text === "string") {
                    chunks.push(part.text);
                }
            }
        }
    }
    return chunks.filter(Boolean).join("\n");
}
