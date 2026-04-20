import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  app,
  buildDateVariants,
  buildUserErrorMessage,
  clampLineText,
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
  timingSafeEqual,
  verifyLineSignature,
} from "../src/index.js";
import { getRuntimeConfig } from "../src/config/runtime.js";
import { fetchGithubFile } from "../src/github/client.js";
import { buildQueryAgentTools, executeQueryToolCall } from "../src/ai/tools.js";

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

function encodeGithubContent(text) {
  return Buffer.from(text, "utf8").toString("base64");
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

function createScheduledFetchMock(pushBodies) {
  return async (url, options = {}) => {
    const normalizedUrl = String(url);

    if (normalizedUrl === LINE_PUSH_ENDPOINT) {
      pushBodies.push(JSON.parse(options.body));
      return new Response("{}", { status: 200 });
    }

    if (!normalizedUrl.startsWith("https://api.github.com/repos/")) {
      throw new Error(`Unexpected fetch url: ${normalizedUrl}`);
    }

    if (normalizedUrl.includes("/contents/AGENTS.md?")) {
      return createJsonResponse({
        content: encodeGithubContent("router instructions"),
      });
    }

    if (
      normalizedUrl.includes("/contents/wiki%2Frules?") ||
      normalizedUrl.includes("/contents/wiki/rules?")
    ) {
      return createJsonResponse([
        { path: "wiki/rules/review-rules.md", type: "file" },
      ]);
    }

    if (
      normalizedUrl.includes("/contents/wiki%2Frules%2Freview-rules.md?") ||
      normalizedUrl.includes("/contents/wiki/rules/review-rules.md?")
    ) {
      return createJsonResponse({
        content: encodeGithubContent("只輸出摘要。"),
      });
    }

    if (
      normalizedUrl.includes("/contents/wiki%2Flog.md?") ||
      normalizedUrl.includes("/contents/wiki/log.md?")
    ) {
      return createJsonResponse({
        content: encodeGithubContent(`
## [2026-04-20] ingest | alpha
- created: \`wiki/summaries/alpha.md\`
        `.trim()),
      });
    }

    if (
      normalizedUrl.includes("/contents/wiki%2Findex.md?") ||
      normalizedUrl.includes("/contents/wiki/index.md?")
    ) {
      return createJsonResponse({
        content: encodeGithubContent(`
## Summaries
- [alpha](wiki/summaries/alpha.md): alpha desc
        `.trim()),
      });
    }

    if (
      normalizedUrl.includes("/contents/wiki%2Fsummaries%2Falpha.md?") ||
      normalizedUrl.includes("/contents/wiki/summaries/alpha.md?")
    ) {
      return createJsonResponse({
        content: encodeGithubContent("# Alpha\n\n今天讀了重點。"),
      });
    }

    throw new Error(`Unhandled GitHub fetch url: ${normalizedUrl}`);
  };
}

test("buildDateVariants includes common date formats", () => {
  const variants = buildDateVariants({ year: 2026, month: 4, day: 19 });

  assert.ok(variants.includes("2026-04-19"));
  assert.ok(variants.includes("2026/4/19"));
  assert.ok(variants.includes("2026年4月19日"));
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

  const result = extractLogForDate(logContent, { year: 2026, month: 4, day: 19 });
  assert.equal(result, "# 2026-04-19\n- Read chapter 1\n- Read chapter 2");
});

test("extractLogForDate falls back to paragraphs when no heading sections exist", () => {
  const logContent = `
2026/04/19 閱讀了 Cloudflare Workers 文件，重點是 AI binding。

2026/04/18 舊紀錄。
`.trim();

  const result = extractLogForDate(logContent, { year: 2026, month: 4, day: 19 });
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
    { slug: "alpha", path: "wiki/summaries/alpha.md", description: "alpha desc" },
    { slug: "beta", path: "wiki/summaries/beta.md", description: "beta desc" },
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
    normalizeWikiPath("./summaries/harness-engineering-language-models-need-human-guidance.md"),
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
  const isoDate = detectReadingLookupDateFromText("2026/4/18 我讀了什麼", current);
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

test("extractAiText supports common Workers AI shapes", () => {
  assert.equal(extractAiText({ response: "summary" }), "summary");
  assert.equal(
    extractAiText({ choices: [{ message: { content: "choice summary" } }] }),
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
    response: "這是 2026/04/18 的閱讀摘要：你閱讀了 1 篇文章，重點是深度處理與回饋迴路。",
  });
  assert.match(reply, /閱讀摘要/);
});

test("extractSummaryReplyFromResult rejects numeric garbage", () => {
  const reply = extractSummaryReplyFromResult({
    response: "-1.0",
  });
  assert.equal(reply, "");
});

test("clampLineText truncates oversized LINE replies", () => {
  const longText = "a".repeat(4600);
  const clamped = clampLineText(longText);

  assert.ok(clamped.length <= 4500);
  assert.match(clamped, /\[內容已截斷\]$/);
});

test("buildUserErrorMessage returns a specific message for Workers AI daily limit", () => {
  const message = buildUserErrorMessage(
    new Error(
      "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
    ),
  );

  assert.equal(
    message,
    "目前 Workers AI 今日免費額度已用完，請稍後再試。",
  );
});

test("handleScheduledSummary pushes today's summary to the configured LINE user", async () => {
  const pushBodies = [];
  const env = {
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_TARGET_USER_ID: "U1234567890abcdef",
    GITHUB_OWNER: "walle4561",
    GITHUB_REPO: "LLM-Wiki",
    GITHUB_TOKEN: "github-token",
    APP_TIMEZONE: "Asia/Taipei",
    AI_MODEL: "@cf/openai/gpt-oss-20b",
    AI: {
      async run() {
        return {
          response: "2026/04/20 你今天讀了 1 篇文章，重點是今天讀了重點。",
        };
      },
    },
  };

  await withMockedFetch(createScheduledFetchMock(pushBodies), async () => {
    await handleScheduledSummary(
      {
        cron: "0 10 * * *",
        scheduledTime: new Date("2026-04-20T10:00:00.000Z").getTime(),
      },
      env,
    );
  });

  assert.equal(pushBodies.length, 1);
  assert.equal(pushBodies[0].to, "U1234567890abcdef");
  assert.equal(
    pushBodies[0].messages[0].text,
    "2026/04/20 你今天讀了 1 篇文章，重點是今天讀了重點。",
  );
});

test("handleScheduledSummary pushes a fallback message when Workers AI daily limit is exhausted", async () => {
  const pushBodies = [];
  const env = {
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    LINE_CHANNEL_SECRET: "line-secret",
    LINE_TARGET_USER_ID: "U1234567890abcdef",
    GITHUB_OWNER: "walle4561",
    GITHUB_REPO: "LLM-Wiki",
    GITHUB_TOKEN: "github-token",
    APP_TIMEZONE: "Asia/Taipei",
    AI_MODEL: "@cf/openai/gpt-oss-20b",
    AI: {
      async run() {
        throw new Error(
          "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
        );
      },
    },
  };

  await withMockedFetch(createScheduledFetchMock(pushBodies), async () => {
    await assert.rejects(
      handleScheduledSummary(
        {
          cron: "0 10 * * *",
          scheduledTime: new Date("2026-04-20T10:00:00.000Z").getTime(),
        },
        env,
      ),
      /4006/,
    );
  });

  assert.equal(pushBodies.length, 1);
  assert.equal(
    pushBodies[0].messages[0].text,
    "目前 Workers AI 今日免費額度已用完，請稍後再試。",
  );
});

test("handleScheduledSummary requires LINE_TARGET_USER_ID", async () => {
  const env = {
    LINE_CHANNEL_ACCESS_TOKEN: "line-token",
    LINE_CHANNEL_SECRET: "line-secret",
    GITHUB_OWNER: "walle4561",
    GITHUB_REPO: "LLM-Wiki",
    GITHUB_TOKEN: "github-token",
    APP_TIMEZONE: "Asia/Taipei",
    AI_MODEL: "@cf/openai/gpt-oss-20b",
    AI: {
      async run() {
        return { response: { rule: "D" } };
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
    /LINE_TARGET_USER_ID/,
  );
});

test("timingSafeEqual matches exact strings only", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
});

test("verifyLineSignature validates LINE webhook signatures", async () => {
  const body = JSON.stringify({ hello: "world" });
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");

  await assert.equal(await verifyLineSignature(body, signature, secret), true);
  await assert.equal(await verifyLineSignature(body, "bad-signature", secret), false);
});

test("getCurrentDateInfo returns timezone based date parts", () => {
  const info = getCurrentDateInfo("Asia/Taipei", new Date("2026-04-19T03:00:00Z"));

  assert.match(info.isoDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(info.timezone, "Asia/Taipei");
  assert.equal(info.displayDate, "2026/04/19");
  assert.equal(info.weekday, "星期日");
});


test("getRuntimeConfig uses fixed summary timeout from code", () => {
  const baseEnv = {
    LINE_CHANNEL_ACCESS_TOKEN: "token",
    LINE_CHANNEL_SECRET: "secret",
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "github-token",
  };

  const defaultConfig = getRuntimeConfig(baseEnv);
  assert.equal(defaultConfig.summaryTimeoutMs, 60000);
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
      await fetchGithubFile(config, "wiki/rules/topic-rules.md", { logInfo });

      assert.equal(fetchCount, 3);
      assert.ok(
        events.every(
          ({ event }) => event !== "github.fetch_cache_hit",
        ),
      );
    },
  );
});

test("buildQueryAgentTools includes get_file_tree for query agent discovery", () => {
  const tools = buildQueryAgentTools({ enableFileTree: true });
  assert.ok(
    tools.some((tool) => tool.function?.name === "get_file_tree"),
  );
  assert.ok(
    tools.some((tool) => tool.function?.name === "get_file"),
  );
});

test("executeQueryToolCall returns full file content without truncation", async () => {
  const longLog = `${"A".repeat(2500)}\n2026-04-20 still visible`;

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
