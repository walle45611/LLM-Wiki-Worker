import { z } from "zod";

const bulletItemSchema = z
    .object({
        label: z.string().optional(),
        text: z.string().min(1),
    })
    .strict();

const blockSchema = z.discriminatedUnion("type", [
    z
        .object({
            type: z.literal("heading"),
            text: z.string().min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal("paragraph"),
            text: z.string().min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal("bullet_list"),
            items: z.array(bulletItemSchema).min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal("quote"),
            text: z.string().min(1),
        })
        .strict(),
    z
        .object({
            type: z.literal("code_block"),
            text: z.string().min(1),
            language: z.string().min(1).optional(),
        })
        .strict(),
    z
        .object({
            type: z.literal("link"),
            text: z.string().min(1),
            url: z.url(),
        })
        .strict(),
]);

const telegramBlockPayloadSchema = z
    .object({
        blocks: z.array(blockSchema).min(1),
    })
    .strict();

function parseTelegramBlockPayload(input) {
    return telegramBlockPayloadSchema.safeParse(input);
}

export function extractAiText(result) {
    if (!result) {
        return "";
    }
    if (typeof result === "string") {
        return result;
    }

    const candidates = [
        typeof result.response === "string" ? result.response : "",
        Array.isArray(result.response)
            ? joinTextParts(
                  result.response.map((item) =>
                      typeof item === "string"
                          ? item
                          : item?.text || item?.content || "",
                  ),
              )
            : "",
        typeof result.output_text === "string" ? result.output_text : "",
        extractOutputText(result.output),
        Array.isArray(result.choices)
            ? joinTextParts(
                  result.choices.map(
                      (choice) => choice?.message?.content || choice?.text || "",
                  ),
              )
            : "",
    ];

    return candidates.find(Boolean) || "";
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

export function containsForbiddenMarkdownReply(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
        return false;
    }

    const patterns = [
        /\*\*[^*\n]+?\*\*/,
        /__[^_\n]+?__/,
        /^#{1,6}\s+\S/m,
        /^(?:\s{0,3}[-*+]\s+\S|\s{0,3}\d+\.\s+\S)/m,
        /```/,
    ];
    return patterns.some((pattern) => pattern.test(trimmed));
}

export function extractTelegramBlockPayloadFromResult(result) {
    const objectCandidates = [
        result?.response,
        result?.result?.response,
        result?.output?.[0]?.content?.[0],
    ];
    for (const candidate of objectCandidates) {
        const parsed = parseTelegramBlockPayload(candidate);
        if (parsed.success) {
            return parsed.data;
        }
    }

    const aiText = extractAiText(result);
    const parsedJson = parseJsonObjectCandidate(aiText);
    if (!parsedJson) {
        return null;
    }
    const parsed = parseTelegramBlockPayload(parsedJson);
    return parsed.success ? parsed.data : null;
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

function parseJsonObjectCandidate(text) {
    const trimmed = String(text || "").trim();
    const jsonStart = trimmed.indexOf("{");
    const jsonEnd = trimmed.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        return null;
    }
    try {
        return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    } catch {
        return null;
    }
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
    if (looksLikeJsonPayload(trimmed)) {
        return "";
    }
    if (containsForbiddenMarkdownReply(trimmed)) {
        return "";
    }

    return trimmed;
}

function looksLikeJsonPayload(text) {
    if (!/^[\[{]/.test(text)) {
        return false;
    }
    if (!/[\]}]$/.test(text)) {
        return false;
    }
    const jsonLike = parseJsonObjectCandidate(text);
    if (!jsonLike || typeof jsonLike !== "object") {
        return false;
    }
    return (
        Object.prototype.hasOwnProperty.call(jsonLike, "blocks") ||
        Object.prototype.hasOwnProperty.call(jsonLike, "type")
    );
}

function extractOutputText(output) {
    if (!Array.isArray(output)) {
        return "";
    }

    const chunks = [];
    for (const item of output) {
        chunks.push(
            typeof item?.text === "string" ? item.text : "",
            typeof item?.content === "string" ? item.content : "",
        );

        if (!Array.isArray(item?.content)) {
            continue;
        }

        for (const part of item.content) {
            chunks.push(
                typeof part === "string"
                    ? part
                    : typeof part?.text === "string"
                      ? part.text
                      : "",
            );
        }
    }

    return joinTextParts(chunks);
}

function joinTextParts(parts) {
    return parts.filter(Boolean).join("\n");
}
