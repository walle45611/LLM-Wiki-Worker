import test from "node:test";
import assert from "node:assert/strict";

import { runQueryAgent } from "../src/flows/query-agent.js";
import {
    createCurrentDateInfo,
    createQueryAgentOptions,
    withMockedFetch,
} from "../testing/helpers.js";

test("runQueryAgent returns payload with prompt-constrained JSON blocks", async () => {
    const aiRequests = [];

    const reply = await runQueryAgent(
        createQueryAgentOptions({
            userPrompt: "今天閱讀了什麼",
            aiBinding: {
                async run(_model, payload) {
                    aiRequests.push(payload);
                    return {
                        response: {
                            blocks: [
                                { type: "heading", text: "閱讀回顧" },
                                { type: "paragraph", text: "今天讀了 1 篇文章。" },
                            ],
                        },
                    };
                },
            },
        }),
    );

    assert.equal(aiRequests.length, 1);
    assert.equal("response_format" in aiRequests[0], false);
    assert.equal(reply.blocks.length, 2);
    assert.equal(reply.blocks[0].type, "heading");
});

test("runQueryAgent falls back to plain text when payload is invalid", async () => {
    const reply = await runQueryAgent(createQueryAgentOptions());

    assert.equal(reply, "這是純文字摘要");
});

test("runQueryAgent rejects markdown-styled plain text fallback", async () => {
    const reply = await runQueryAgent(
        createQueryAgentOptions({
            aiBinding: {
                async run() {
                    return {
                        response: "**這是純文字摘要**",
                    };
                },
            },
        }),
    );

    assert.equal(reply, "目前有找到資料，但暫時無法整理成可讀回覆，請稍後再試。");
});

test("runQueryAgent returns timeout reply when AI deadline is exceeded", async () => {
    const reply = await runQueryAgent(
        createQueryAgentOptions({
            timeoutMs: 10,
            aiBinding: {
                async run() {
                    return new Promise(() => {});
                },
            },
        }),
    );

    assert.equal(reply, "目前整理流程逾時，請稍後再試。");
});

test("runQueryAgent returns knowledge timeout reply when GitHub tool call times out", async () => {
    await withMockedFetch(
        () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            return Promise.reject(error);
        },
        async () => {
            const reply = await runQueryAgent(
                createQueryAgentOptions({
                    aiBinding: {
                        async run() {
                            return {
                                response: {
                                    tool_calls: [
                                        {
                                            id: "call_1",
                                            type: "function",
                                            function: {
                                                name: "get_file",
                                                arguments: JSON.stringify({
                                                    path: "wiki/rules/router-rules.md",
                                                }),
                                            },
                                        },
                                    ],
                                },
                            };
                        },
                    },
                    currentDateInfo: createCurrentDateInfo(),
                }),
            );

            assert.equal(reply, "目前讀取知識庫逾時，請稍後再試。");
        },
    );
});
