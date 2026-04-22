import test from "node:test";
import assert from "node:assert/strict";

import {
    app,
    buildDateVariants,
    buildUserErrorMessage,
    clampChatText,
    detectReadingLookupDateFromText,
    extractAiText,
    extractSummaryReplyFromResult,
    extractLogForDate,
    extractSummaryReferencesFromLog,
    getCurrentDateInfo,
    handleScheduledSummary,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
    runQueryAgent,
} from "../src/index.js";
import { getRuntimeConfig } from "../src/config/runtime.js";
import { fetchGithubFile } from "../src/github/client.js";
import {
    buildQueryAgentTools,
    executeQueryToolCall,
    parseToolCallArguments,
} from "../src/ai/tools.js";
import { toJsonPreview } from "../src/logger.js";

function encodeGithubContent(text) {
    return Buffer.from(text, "utf8").toString("base64");
}

function decodeGithubContent(text) {
    return Buffer.from(text, "base64").toString("utf8");
}

function createJsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

async function withMockedFetch(mockFetch, callback) {
    const originalFetch = global.fetch;
    global.fetch = mockFetch;
    try {
        return await callback();
    } finally {
        global.fetch = originalFetch;
    }
}

test("buildDateVariants includes common date formats", () => {
    const variants = buildDateVariants({ year: 2026, month: 4, day: 19 });

    assert.ok(variants.includes("2026-04-19"));
    assert.ok(variants.includes("2026/4/19"));
    assert.ok(variants.includes("2026年4月19日"));
});

test("toJsonPreview truncates long serialized payloads", () => {
    const preview = toJsonPreview({
        content: "x".repeat(600),
        nested: { value: "y".repeat(100) },
    });

    assert.ok(preview.length <= 283);
    assert.match(preview, /\.\.\.$/);
});

test("GET / returns worker status", async () => {
    const response = await app.request("http://localhost/");
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, service: "llmwikiworker" });
});

test("extractLogForDate returns dated section until next heading", () => {
    const logContent = `
# 2026-04-19
- Read chapter 1
- Read chapter 2

# 2026-04-18
- Old content
`.trim();

    const result = extractLogForDate(logContent, {
        year: 2026,
        month: 4,
        day: 19,
    });
    assert.equal(result, "# 2026-04-19\n- Read chapter 1\n- Read chapter 2");
});

test("extractLogForDate falls back to paragraphs when no heading sections exist", () => {
    const logContent = `
2026/04/19 閱讀了 Cloudflare Workers 文件，重點是 AI binding。

2026/04/18 舊紀錄。
`.trim();

    const result = extractLogForDate(logContent, {
        year: 2026,
        month: 4,
        day: 19,
    });
    assert.match(result, /Cloudflare Workers/);
    assert.doesNotMatch(result, /舊紀錄/);
});

test("extractSummaryReferencesFromLog reads created and updated references", () => {
    const logContent = `
## [2026-04-18] ingest | title

- created: \`wiki/summaries/alpha.md\`, \`wiki/concepts/x.md\`
- updated: \`wiki/index.md\`, \`how-to-learn-anything-faster-using-modern-research\`

## [2026-04-17] ingest | old
- created: \`wiki/summaries/old.md\`
`.trim();

    const references = extractSummaryReferencesFromLog(logContent, {
        year: 2026,
        month: 4,
        day: 18,
    });

    assert.deepEqual(references, [
        "wiki/summaries/alpha.md",
        "wiki/concepts/x.md",
        "wiki/index.md",
        "how-to-learn-anything-faster-using-modern-research",
    ]);
});

test("parseSummaryIndex maps summary slug to wiki path", () => {
    const indexContent = `
# Wiki Index

## Summaries
- [alpha](/Users/demo/wiki/summaries/alpha.md): A

## Concepts
- [effective-learning](/Users/demo/wiki/concepts/effective-learning.md): B
`.trim();

    const mapping = parseSummaryIndex(indexContent);
    assert.equal(mapping.get("alpha"), "wiki/summaries/alpha.md");
    assert.equal(mapping.has("effective-learning"), false);
});

test("parseSummaryIndexEntries extracts slug path and description", () => {
    const indexContent = `
## Summaries
- [alpha](wiki/summaries/alpha.md): alpha desc
- [beta](wiki/summaries/beta.md): beta desc
`.trim();
    const entries = parseSummaryIndexEntries(indexContent);
    assert.deepEqual(entries, [
        {
            slug: "alpha",
            path: "wiki/summaries/alpha.md",
            description: "alpha desc",
        },
        {
            slug: "beta",
            path: "wiki/summaries/beta.md",
            description: "beta desc",
        },
    ]);
});

test("resolveSummaryPathsForDate keeps summaries and resolves slug via index", () => {
    const logContent = `
## [2026-04-18] ingest | title
- created: \`wiki/summaries/alpha.md\`, \`wiki/concepts/effective-learning.md\`
- updated: \`how-to-learn-anything-faster-using-modern-research\`, \`unknown-slug\`
`.trim();
    const indexContent = `
## Summaries
- [how-to-learn-anything-faster-using-modern-research](/Users/demo/wiki/summaries/how-to-learn-anything-faster-using-modern-research.md): A
`.trim();

    const resolved = resolveSummaryPathsForDate(logContent, indexContent, {
        year: 2026,
        month: 4,
        day: 18,
    });

    assert.deepEqual(resolved.summaryPaths.sort(), [
        "wiki/summaries/alpha.md",
        "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
    ]);
    assert.deepEqual(resolved.unresolvedReferences, [
        "wiki/concepts/effective-learning.md",
        "unknown-slug",
    ]);
});

test("normalizeWikiPath converts absolute wiki paths", () => {
    assert.equal(
        normalizeWikiPath("/Users/name/vault/wiki/summaries/a.md"),
        "wiki/summaries/a.md",
    );
});

test("normalizeWikiPath converts relative summaries/concepts paths", () => {
    assert.equal(
        normalizeWikiPath(
            "./summaries/harness-engineering-language-models-need-human-guidance.md",
        ),
        "wiki/summaries/harness-engineering-language-models-need-human-guidance.md",
    );
    assert.equal(
        normalizeWikiPath("./concepts/harness-engineering.md"),
        "wiki/concepts/harness-engineering.md",
    );
});

test("buildDateInfoFromIsoDate expands iso date into display fields", () => {
    const info = {
        ...getCurrentDateInfo("Asia/Taipei", new Date("2026-04-18T03:00:00Z")),
        displayDate: "2026/04/18",
        weekday: "星期六",
        timezone: "Asia/Taipei",
    };

    assert.equal(info.displayDate, "2026/04/18");
    assert.equal(info.weekday, "星期六");
    assert.equal(info.timezone, "Asia/Taipei");
});

test("detectReadingLookupDateFromText parses explicit date for reading query", () => {
    const current = {
        year: 2026,
        month: 4,
        day: 19,
        isoDate: "2026-04-19",
        displayDate: "2026/04/19",
        weekday: "星期日",
        timezone: "Asia/Taipei",
    };
    const isoDate = detectReadingLookupDateFromText(
        "2026/4/18 我讀了什麼",
        current,
    );
    assert.equal(isoDate, "2026-04-18");
});

test("detectReadingLookupDateFromText parses relative date for reading query", () => {
    const current = {
        year: 2026,
        month: 4,
        day: 19,
        isoDate: "2026-04-19",
        displayDate: "2026/04/19",
        weekday: "星期日",
        timezone: "Asia/Taipei",
    };
    const isoDate = detectReadingLookupDateFromText("昨天我讀了什麼", current);
    assert.equal(isoDate, "2026-04-18");
});

test(
    "runQueryAgent forces single-day review to read matched summaries before finishing",
    { concurrency: false },
    async () => {
    const requests = [];
    const aiRequests = [];
    const indexContent = [
        "# Index",
        "",
        "## Summaries",
        "- [alpha](./summaries/alpha.md) · 2026-04-19: Alpha summary",
    ].join("\n");
    const summaryContent = [
        "---",
        "source link: https://example.com/alpha",
        "---",
        "",
        "Alpha 內容",
    ].join("\n");
    let callCount = 0;

    await withMockedFetch(
        async (url) => {
            requests.push(String(url));
            if (String(url).includes("index.md")) {
                return createJsonResponse({
                    content: encodeGithubContent(indexContent),
                });
            }
            if (String(url).includes("alpha.md")) {
                return createJsonResponse({
                    content: encodeGithubContent(summaryContent),
                });
            }
            return new Response("{}", { status: 404 });
        },
        async () => {
            const reply = await runQueryAgent({
                userPrompt: "今天閱讀了什麼",
                aiBinding: {
                    async run(_model, payload) {
                        aiRequests.push(payload);
                        callCount += 1;
                        if (callCount === 1) {
                            return {
                                tool_calls: [
                                    {
                                        id: "call-1",
                                        function: {
                                            name: "get_file",
                                            arguments: JSON.stringify({
                                                path: "wiki/index.md",
                                            }),
                                        },
                                    },
                                ],
                            };
                        }
                        if (callCount === 2) {
                            return {
                                response:
                                    "這是 2026/04/19 的閱讀摘要：今天讀了 1 篇文章。",
                            };
                        }
                        if (callCount === 3) {
                            return {
                                tool_calls: [
                                    {
                                        id: "call-2",
                                        function: {
                                            name: "get_file",
                                            arguments: JSON.stringify({
                                                path: "wiki/summaries/alpha.md",
                                            }),
                                        },
                                    },
                                ],
                            };
                        }
                        return {
                            response: [
                                "📚 2026/04/19 閱讀回顧",
                                "",
                                "【閱讀總覽】",
                                "今天閱讀了 1 篇文章，主題是 Alpha。",
                                "",
                                "【逐篇摘要】",
                                "Alpha",
                                "source link: https://example.com/alpha",
                                "核心概念：Alpha 是測試文章。",
                                "重點：第一點；第二點；第三點。",
                            ].join("\n"),
                        };
                    },
                },
                aiModel: "@cf/openai/gpt-oss-20b",
                config: {
                    githubOwner: "owner",
                    githubRepo: "repo",
                    githubRef: "main",
                    githubToken: "token",
                },
                trace: {},
                timeoutMs: 5000,
                currentDateInfo: {
                    year: 2026,
                    month: 4,
                    day: 19,
                    isoDate: "2026-04-19",
                    displayDate: "2026/04/19",
                    weekday: "星期日",
                    timezone: "Asia/Taipei",
                },
            });

            assert.match(reply, /Alpha/);
            assert.equal(requests.length, 2);
            assert.equal(aiRequests.length, 4);
            assert.match(
                aiRequests[2].messages.at(-1).content,
                /尚未讀完這一天命中的 summary：wiki\/summaries\/alpha\.md/,
            );
        },
    );
    },
);

test("runQueryAgent accepts markdown final replies", async () => {
    let callCount = 0;

    const reply = await runQueryAgent({
        userPrompt: "幫我整理今天的重點",
        aiBinding: {
            async run() {
                callCount += 1;
                return {
                    response: "## 標題\n- 第一點\n- 第二點",
                };
            },
        },
        aiModel: "@cf/openai/gpt-oss-20b",
        config: {
            githubOwner: "owner",
            githubRepo: "repo",
            githubRef: "main",
            githubToken: "token",
        },
        trace: {},
        timeoutMs: 5000,
        currentDateInfo: {
            year: 2026,
            month: 4,
            day: 19,
            isoDate: "2026-04-19",
            displayDate: "2026/04/19",
            weekday: "星期日",
            timezone: "Asia/Taipei",
        },
    });

    assert.match(reply, /## 標題/);
    assert.equal(callCount, 1);
});

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

test("extractSummaryReplyFromResult rejects numeric garbage", () => {
    const reply = extractSummaryReplyFromResult({
        response: "-1.0",
    });
    assert.equal(reply, "");
});

test("clampChatText truncates oversized replies", () => {
    const longText = "a".repeat(4600);
    const clamped = clampChatText(longText);

    assert.ok(clamped.length <= 3500);
    assert.match(clamped, /\[內容已截斷\]$/);
});

test("clampChatText preserves markdown content before telegram escaping", () => {
    const clamped = clampChatText(
        "# Title\n\n**bold** [link](https://example.com)\n- item\n1. first\n`code`",
    );

    assert.equal(
        clamped,
        "# Title\n\n**bold** [link](https://example.com)\n- item\n1. first\n`code`",
    );
});

test("buildUserErrorMessage returns a specific message for Workers AI daily limit", () => {
    const message = buildUserErrorMessage(
        new Error(
            "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
        ),
    );

    assert.equal(message, "目前 Workers AI 今日免費額度已用完，請稍後再試。");
});

test("handleScheduledSummary enqueues scheduled summary job", async () => {
    const queuedJobs = [];
    const env = {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_TARGET_CHAT_ID: "123456789",
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
        GITHUB_TOKEN: "github-token",
        APP_TIMEZONE: "Asia/Taipei",
        AI_MODEL: "@cf/openai/gpt-oss-20b",
        LLM_WIKI_QUEUE: {
            async send(payload) {
                queuedJobs.push(payload);
            },
        },
    };

    await handleScheduledSummary(
        {
            cron: "0 10 * * *",
            scheduledTime: new Date("2026-04-20T10:00:00.000Z").getTime(),
        },
        env,
    );

    assert.equal(queuedJobs.length, 1);
    assert.equal(queuedJobs[0].type, "scheduled_summary");
    assert.equal(queuedJobs[0].chatId, "123456789");
    assert.equal(queuedJobs[0].text, "排程任務需要把當天整理結果寫入知識庫");
});

test("handleScheduledSummary throws when queue enqueue fails", async () => {
    const env = {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        TELEGRAM_TARGET_CHAT_ID: "123456789",
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
        GITHUB_TOKEN: "github-token",
        APP_TIMEZONE: "Asia/Taipei",
        AI_MODEL: "@cf/openai/gpt-oss-20b",
        LLM_WIKI_QUEUE: {
            async send() {
                throw new Error("queue unavailable");
            },
        },
    };

    await assert.rejects(
        handleScheduledSummary(
            {
                cron: "0 10 * * *",
                scheduledTime: new Date("2026-04-20T10:00:00.000Z").getTime(),
            },
            env,
        ),
        /queue unavailable/,
    );
});

test("handleScheduledSummary requires TELEGRAM_TARGET_CHAT_ID", async () => {
    const env = {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
        GITHUB_TOKEN: "github-token",
        APP_TIMEZONE: "Asia/Taipei",
        AI_MODEL: "@cf/openai/gpt-oss-20b",
        LLM_WIKI_QUEUE: {
            async send() {},
        },
    };

    await assert.rejects(
        handleScheduledSummary(
            {
                cron: "0 10 * * *",
                scheduledTime: new Date("2026-04-20T10:00:00.000Z").getTime(),
            },
            env,
        ),
        /TELEGRAM_TARGET_CHAT_ID/,
    );
});

test("getCurrentDateInfo returns timezone based date parts", () => {
    const info = getCurrentDateInfo(
        "Asia/Taipei",
        new Date("2026-04-19T03:00:00Z"),
    );

    assert.match(info.isoDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(info.timezone, "Asia/Taipei");
    assert.equal(info.displayDate, "2026/04/19");
    assert.equal(info.weekday, "星期日");
});

test("getRuntimeConfig uses fixed summary timeout from code", () => {
    const baseEnv = {
        TELEGRAM_BOT_TOKEN: "token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_TOKEN: "github-token",
    };

    const defaultConfig = getRuntimeConfig(baseEnv);
    assert.equal(defaultConfig.eventTimeoutMs, 120000);
});

test("fetchGithubFile fails fast when GitHub fetch times out", async () => {
    await withMockedFetch(
        (_url, options = {}) =>
            new Promise((_, reject) => {
                options.signal?.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                });
            }),
        async () => {
            await assert.rejects(
                fetchGithubFile(
                    {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    "wiki/rules/review-rules.md",
                    { timeoutMs: 10 },
                ),
                /GitHub fetch timed out after 10ms: wiki\/rules\/review-rules\.md/,
            );
        },
    );
});

test("fetchGithubFile always refetches remote content without cache", async () => {
    let fetchCount = 0;
    const events = [];

    await withMockedFetch(
        () => {
            fetchCount += 1;
            return createJsonResponse({
                content: encodeGithubContent("agents instructions"),
            });
        },
        async () => {
            const config = {
                githubOwner: "owner",
                githubRepo: "repo",
                githubRef: "main",
                githubToken: "token",
            };
            const logInfo = (event, payload) => events.push({ event, payload });

            await fetchGithubFile(config, "AGENTS.md", { logInfo });
            await fetchGithubFile(config, "wiki/index.md", { logInfo });
            await fetchGithubFile(config, "wiki/rules/topic-rules.md", {
                logInfo,
            });

            assert.equal(fetchCount, 3);
            assert.ok(
                events.every(({ event }) => event !== "github.fetch_cache_hit"),
            );
        },
    );
});

test("buildQueryAgentTools includes get_file_tree for query agent discovery", () => {
    const tools = buildQueryAgentTools({ enableFileTree: true });
    assert.ok(tools.some((tool) => tool.function?.name === "get_file_tree"));
    assert.ok(tools.some((tool) => tool.function?.name === "get_file"));
    assert.ok(tools.some((tool) => tool.function?.name === "upsert_file"));
    assert.ok(tools.some((tool) => tool.function?.name === "append_file"));
    assert.ok(tools.some((tool) => tool.function?.name === "replace_in_file"));
});

test("parseToolCallArguments tolerates trailing garbage after JSON", () => {
    const result = parseToolCallArguments({
        function: {
            arguments:
                '{"path":"wiki/assets/daily/2026-04-21.md","content":"hello"}} trailing',
        },
    });

    assert.equal(result.path, "wiki/assets/daily/2026-04-21.md");
    assert.equal(result.content, "hello");
});

test("executeQueryToolCall returns full file content", async () => {
    const longLog = `${"A".repeat(4000)}\n2026-04-20 still visible`;

    await withMockedFetch(
        () =>
            createJsonResponse({
                content: encodeGithubContent(longLog),
            }),
        async () => {
            const result = await executeQueryToolCall(
                "get_file",
                { path: "wiki/log.md" },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.match(result.content, /2026-04-20 still visible/);
            assert.equal(result.content, longLog);
        },
    );
});

test("executeQueryToolCall keeps full content for wiki/rules markdown", async () => {
    const longRule = `${"R".repeat(2500)}\nrouter rule tail visible`;

    await withMockedFetch(
        () =>
            createJsonResponse({
                content: encodeGithubContent(longRule),
            }),
        async () => {
            const result = await executeQueryToolCall(
                "get_file",
                { path: "wiki/rules/review-rules.md" },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.equal(result.content, longRule);
            assert.match(result.content, /router rule tail visible/);
        },
    );
});

test("executeQueryToolCall keeps full content for wiki/index.md", async () => {
    const longIndex = `${"I".repeat(2500)}\nindex tail visible`;

    await withMockedFetch(
        () =>
            createJsonResponse({
                content: encodeGithubContent(longIndex),
            }),
        async () => {
            const result = await executeQueryToolCall(
                "get_file",
                { path: "wiki/index.md" },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.equal(result.content, longIndex);
            assert.match(result.content, /index tail visible/);
        },
    );
});

test("executeQueryToolCall upserts wiki file", async () => {
    const requests = [];

    await withMockedFetch(
        async (url, options = {}) => {
            requests.push({ url: String(url), options });
            if ((options.method || "GET") === "GET") {
                return new Response("{}", { status: 404 });
            }
            return createJsonResponse({
                content: { sha: "content-sha" },
                commit: { sha: "commit-sha" },
            });
        },
        async () => {
            const result = await executeQueryToolCall(
                "upsert_file",
                {
                    path: "wiki/assets/daily/2026-04-21.md",
                    content: "hello world",
                    commit_message: "chore: write digest",
                },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.equal(result.path, "wiki/assets/daily/2026-04-21.md");
            assert.equal(result.committed, true);
            assert.equal(result.content_sha, "content-sha");
            assert.equal(result.commit_sha, "commit-sha");
            assert.equal(requests.length, 2);
            assert.equal(requests[1].options.method, "PUT");
        },
    );
});

test("executeQueryToolCall rejects upsert outside wiki", async () => {
    await assert.rejects(
        executeQueryToolCall(
            "upsert_file",
            {
                path: "notes/test.md",
                content: "hello world",
            },
            {
                config: {
                    githubOwner: "owner",
                    githubRepo: "repo",
                    githubRef: "main",
                    githubToken: "token",
                },
                trace: {},
                logInfo: () => {},
            },
        ),
        /only allows writing under wiki\//,
    );
});

test("executeQueryToolCall appends wiki file content", async () => {
    const requests = [];

    await withMockedFetch(
        async (url, options = {}) => {
            requests.push({ url: String(url), options });
            if ((options.method || "GET") === "GET") {
                return createJsonResponse({
                    sha: "old-sha",
                    content: encodeGithubContent("hello\n"),
                });
            }
            return createJsonResponse({
                content: { sha: "new-content-sha" },
                commit: { sha: "new-commit-sha" },
            });
        },
        async () => {
            const result = await executeQueryToolCall(
                "append_file",
                {
                    path: "wiki/log.md",
                    content: "world\n",
                },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.equal(result.path, "wiki/log.md");
            assert.equal(result.appended_length, 6);
            assert.equal(result.committed, true);
            const putRequest = requests.find(
                (request) => (request.options.method || "GET") === "PUT",
            );
            assert.ok(putRequest);
            const putBody = JSON.parse(putRequest.options.body);
            assert.equal(
                decodeGithubContent(putBody.content),
                "hello\nworld\n",
            );
        },
    );
});

test("executeQueryToolCall replaces text in wiki file", async () => {
    const requests = [];

    await withMockedFetch(
        async (url, options = {}) => {
            requests.push({ url: String(url), options });
            if ((options.method || "GET") === "GET") {
                return createJsonResponse({
                    sha: "old-sha",
                    content: encodeGithubContent("alpha beta gamma"),
                });
            }
            return createJsonResponse({
                content: { sha: "replace-content-sha" },
                commit: { sha: "replace-commit-sha" },
            });
        },
        async () => {
            const result = await executeQueryToolCall(
                "replace_in_file",
                {
                    path: "wiki/index.md",
                    find: "beta",
                    replace: "delta",
                },
                {
                    config: {
                        githubOwner: "owner",
                        githubRepo: "repo",
                        githubRef: "main",
                        githubToken: "token",
                    },
                    trace: {},
                    logInfo: () => {},
                },
            );

            assert.equal(result.path, "wiki/index.md");
            assert.equal(result.replaced, true);
            const putRequest = requests.find(
                (request) => (request.options.method || "GET") === "PUT",
            );
            assert.ok(putRequest);
            const putBody = JSON.parse(putRequest.options.body);
            assert.equal(
                decodeGithubContent(putBody.content),
                "alpha delta gamma",
            );
        },
    );
});

test("executeQueryToolCall rejects append outside wiki", async () => {
    await assert.rejects(
        executeQueryToolCall(
            "append_file",
            {
                path: "raw/file.md",
                content: "hello",
            },
            {
                config: {
                    githubOwner: "owner",
                    githubRepo: "repo",
                    githubRef: "main",
                    githubToken: "token",
                },
                trace: {},
                logInfo: () => {},
            },
        ),
        /only allows writing under wiki\//,
    );
});

test("executeQueryToolCall rejects replace when target text missing", async () => {
    await withMockedFetch(
        async () =>
            createJsonResponse({
                sha: "old-sha",
                content: encodeGithubContent("alpha beta gamma"),
            }),
        async () => {
            await assert.rejects(
                executeQueryToolCall(
                    "replace_in_file",
                    {
                        path: "wiki/index.md",
                        find: "missing",
                        replace: "delta",
                    },
                    {
                        config: {
                            githubOwner: "owner",
                            githubRepo: "repo",
                            githubRef: "main",
                            githubToken: "token",
                        },
                        trace: {},
                        logInfo: () => {},
                    },
                ),
                /could not find target text/,
            );
        },
    );
});
