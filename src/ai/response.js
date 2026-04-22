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
        return result.response
            .map((item) =>
                typeof item === "string"
                    ? item
                    : item?.text || item?.content || "",
            )
            .filter(Boolean)
            .join("\n");
    }
    if (typeof result.output_text === "string") {
        return result.output_text;
    }

    const outputText = extractOutputText(result.output);
    if (outputText) {
        return outputText;
    }

    if (Array.isArray(result.choices)) {
        return result.choices
            .map((choice) => choice?.message?.content || choice?.text || "")
            .filter(Boolean)
            .join("\n");
    }

    return "";
}

export function extractSummaryReplyFromResult(result) {
    const response = result?.response;
    if (response && typeof response === "object" && !Array.isArray(response)) {
        if (typeof response.reply === "string") {
            return response.reply;
        }
        if (typeof response.response === "string") {
            return response.response;
        }
    }

    const text = extractAiText(result);
    const parsedReply = parseReplyPayload(text);
    if (parsedReply) {
        return parsedReply;
    }

    return parseSafePlainReply(text);
}

function parseReplyPayload(text) {
    const trimmed = String(text || "").trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        return "";
    }

    try {
        const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
        if (typeof parsed?.reply === "string" && parsed.reply.trim()) {
            return parsed.reply;
        }
        if (typeof parsed?.response === "string" && parsed.response.trim()) {
            return parsed.response;
        }
    } catch {
        return "";
    }

    return "";
}

function parseSafePlainReply(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
        return "";
    }
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
