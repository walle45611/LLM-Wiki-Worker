import test from "node:test";
import assert from "node:assert/strict";

import {
    app,
    buildDateVariants,
    buildUserErrorMessage,
    clampChatText,
    containsForbiddenMarkdownReply,
    detectReadingLookupDateFromText,
    extractAiText,
    extractSummaryReplyFromResult,
    extractTelegramBlockPayloadFromResult,
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
import {
    getRuntimeConfig,
    requireTelegramWebhookSecret,
    TELEGRAM_WEBHOOK_SECRET_HEADER,
} from "../src/config/runtime.js";
import { fetchGithubFile } from "../src/github/client.js";
import {
    buildQueryAgentTools,
    executeQueryToolCall,
    parseToolCallArguments,
} from "../src/ai/tools.js";
import { toJsonPreview } from "../src/logger.js";
import { sendTelegramMessage } from "../src/telegram/client.js";

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

test("POST /webhook rejects requests without telegram secret header", async () => {
    const response = await app.request(
        "http://localhost/webhook",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ update_id: 1 }),
        },
        {
            TELEGRAM_BOT_TOKEN: "telegram-token",
            TELEGRAM_WEBHOOK_SECRET: "expected-secret",
            LLM_WIKI_QUEUE: { async send() {} },
        },
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Unauthorized");
});

test("POST /webhook rejects requests with wrong telegram secret header", async () => {
    const response = await app.request(
        "http://localhost/webhook",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                [TELEGRAM_WEBHOOK_SECRET_HEADER]: "wrong-secret",
            },
            body: JSON.stringify({ update_id: 1 }),
        },
        {
            TELEGRAM_BOT_TOKEN: "telegram-token",
            TELEGRAM_WEBHOOK_SECRET: "expected-secret",
            LLM_WIKI_QUEUE: { async send() {} },
        },
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Unauthorized");
});

test("requireTelegramWebhookSecret returns configured secret", () => {
    assert.equal(
        requireTelegramWebhookSecret({
            TELEGRAM_WEBHOOK_SECRET: "expected-secret",
        }),
        "expected-secret",
    );
});

test("sendTelegramMessage falls back to plain text when entities parsing fails", async () => {
    const requests = [];

    const customFetch = async (input, init = {}) => {
        requests.push({
            url: String(input),
            body: init.body ? JSON.parse(String(init.body)) : null,
        });

        if (requests.length === 1) {
            return createJsonResponse(
                {
                    ok: false,
                    error_code: 400,
                    description:
                        "Bad Request: can't parse entities: Character '-' is reserved and must be escaped with the preceding '\\'",
                },
                400,
            );
        }

        return createJsonResponse({
            ok: true,
            result: {
                message_id: 123,
            },
        });
    };

    await sendTelegramMessage(
        "123456789",
        {
            blocks: [{ type: "heading", text: "MicroK8s summary" }],
        },
        "telegram-token",
        { fetch: customFetch },
    );

    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /sendMessage$/);
    assert.equal(requests[0].body.text, "MicroK8s summary");
    assert.equal(Array.isArray(requests[0].body.entities), true);
    assert.equal(requests[0].body.entities[0].type, "bold");
    assert.equal(requests[1].body.text, "MicroK8s summary");
    assert.equal("entities" in requests[1].body, false);
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

test("runQueryAgent returns payload with prompt-constrained JSON blocks", async () => {
    const aiRequests = [];

    const reply = await runQueryAgent({
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

    assert.equal(aiRequests.length, 1);
    assert.equal("response_format" in aiRequests[0], false);
    assert.equal(reply.blocks.length, 2);
    assert.equal(reply.blocks[0].type, "heading");
});

test("runQueryAgent falls back to plain text when payload is invalid", async () => {
    const reply = await runQueryAgent({
        userPrompt: "幫我整理今天的重點",
        aiBinding: {
            async run() {
                return {
                    response: "這是純文字摘要",
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

    assert.equal(reply, "這是純文字摘要");
});

test("runQueryAgent rejects markdown-styled plain text fallback", async () => {
    const reply = await runQueryAgent({
        userPrompt: "幫我整理今天的重點",
        aiBinding: {
            async run() {
                return {
                    response: "**這是純文字摘要**",
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

    assert.equal(reply, "目前有找到資料，但暫時無法整理成可讀回覆，請稍後再試。");
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

test("containsForbiddenMarkdownReply detects common markdown formatting", () => {
    assert.equal(containsForbiddenMarkdownReply("**重點**"), true);
    assert.equal(containsForbiddenMarkdownReply("# 標題"), true);
    assert.equal(containsForbiddenMarkdownReply("- 清單"), true);
    assert.equal(containsForbiddenMarkdownReply("這是一般純文字摘要。"), false);
});

test("extractSummaryReplyFromResult rejects markdown-styled plain text", () => {
    const reply = extractSummaryReplyFromResult({
        response: "**這是摘要**",
    });
    assert.equal(reply, "");
});

test("extractSummaryReplyFromResult rejects numeric garbage", () => {
    const reply = extractSummaryReplyFromResult({
        response: "-1.0",
    });
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
        TELEGRAM_CHAT_ID: "123456789",
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
        TELEGRAM_CHAT_ID: "123456789",
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

test("handleScheduledSummary requires TELEGRAM_CHAT_ID", async () => {
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
        /TELEGRAM_CHAT_ID/,
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
    assert.ok(
        tools.some((tool) => tool.function?.name === "get_current_date_info"),
    );
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

test("executeQueryToolCall returns current date info", async () => {
    const result = await executeQueryToolCall("get_current_date_info", {}, {
        currentDateInfo: {
            timezone: "Asia/Taipei",
            displayDate: "2026/04/23",
            weekday: "星期四",
            isoDate: "2026-04-23",
        },
        trace: {},
        logInfo: () => {},
    });

    assert.deepEqual(result, {
        timezone: "Asia/Taipei",
        displayDate: "2026/04/23",
        weekday: "星期四",
        isoDate: "2026-04-23",
    });
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
