import test from "node:test";
import assert from "node:assert/strict";

import {
    containsForbiddenMarkdownReply,
    extractAiText,
    extractSummaryReplyFromResult,
    extractTelegramBlockPayloadFromResult,
} from "../src/ai/response.js";

test("extractAiText supports common Workers AI shapes", () => {
    assert.equal(extractAiText({ response: "summary" }), "summary");
    assert.equal(
        extractAiText({
            choices: [{ message: { content: "choice summary" } }],
        }),
        "choice summary",
    );
    assert.equal(
        extractAiText({
            output: [{ content: [{ text: "output summary" }] }],
        }),
        "output summary",
    );
});

test("extractSummaryReplyFromResult prefers schema response.reply", () => {
    const reply = extractSummaryReplyFromResult({
        response: { reply: "這是最終摘要" },
    });
    assert.equal(reply, "這是最終摘要");
});

test("extractSummaryReplyFromResult parses JSON wrapped reply text", () => {
    const reply = extractSummaryReplyFromResult({
        response: 'The user wants...\n{"reply":"這是摘要"}',
    });
    assert.equal(reply, "這是摘要");
});

test("extractSummaryReplyFromResult parses JSON wrapped response text", () => {
    const reply = extractSummaryReplyFromResult({
        response: 'draft...\n{"response":"這是摘要"}',
    });
    assert.equal(reply, "這是摘要");
});

test("extractSummaryReplyFromResult returns empty when no structured reply exists", () => {
    const reply = extractSummaryReplyFromResult({
        response: "The user wants a summary...",
    });
    assert.equal(reply, "");
});

test("extractSummaryReplyFromResult accepts safe plain text reply", () => {
    const reply = extractSummaryReplyFromResult({
        response:
            "這是 2026/04/18 的閱讀摘要：你閱讀了 1 篇文章，重點是深度處理與回饋迴路。",
    });
    assert.match(reply, /閱讀摘要/);
});

test("containsForbiddenMarkdownReply detects common markdown formatting", () => {
    assert.equal(containsForbiddenMarkdownReply("**重點**"), true);
    assert.equal(containsForbiddenMarkdownReply("# 標題"), true);
    assert.equal(containsForbiddenMarkdownReply("- 清單"), true);
    assert.equal(containsForbiddenMarkdownReply("這是一般純文字摘要。"), false);
});

test("extractSummaryReplyFromResult rejects markdown-styled plain text", () => {
    const reply = extractSummaryReplyFromResult({ response: "**這是摘要**" });
    assert.equal(reply, "");
});

test("extractSummaryReplyFromResult rejects numeric garbage", () => {
    const reply = extractSummaryReplyFromResult({ response: "-1.0" });
    assert.equal(reply, "");
});

test("extractTelegramBlockPayloadFromResult parses wrapped payload text", () => {
    const payload = extractTelegramBlockPayloadFromResult({
        response: 'draft...\n{"blocks":[{"type":"paragraph","text":"摘要"}]}',
    });
    assert.equal(payload.blocks.length, 1);
    assert.equal(payload.blocks[0].type, "paragraph");
});

test("extractSummaryReplyFromResult rejects JSON-like payload text", () => {
    const reply = extractSummaryReplyFromResult({
        response:
            '{"blocks":[{"type":"paragraph","url":"https://github.com/example/repo/blob/main/wiki/log.md"}]}',
    });
    assert.equal(reply, "");
});
