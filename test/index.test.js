import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  app,
  buildDateInfoFromIsoDate,
  buildDateVariants,
  clampLineText,
  detectReadingLookupDateFromText,
  extractAiText,
  extractSummaryReplyFromResult,
  extractLogForDate,
  extractSummaryReferencesFromLog,
  getCurrentDateInfo,
  normalizeWikiPath,
  parseSummaryLookupDecision,
  parseSummaryIndex,
  parseSummaryIndexEntries,
  resolveIntentAndRule,
  resolveRuleBSummaryPath,
  resolveSummaryPathsForDate,
  summarizeReadingLog,
  timingSafeEqual,
  verifyLineSignature,
} from "../src/index.js";
import { buildSummaryReplyResponseFormat } from "../src/ai/format.js";
import { runAiTextGeneration } from "../src/ai/runner.js";

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

test("resolveIntentAndRule defaults to rule B when router payload is invalid", async () => {
  const current = {
    year: 2026,
    month: 4,
    day: 19,
    isoDate: "2026-04-19",
    displayDate: "2026/04/19",
    weekday: "星期日",
    timezone: "Asia/Taipei",
  };
  const route = await resolveIntentAndRule(
    "昨天我讀了什麼",
    current,
    "router instructions",
    {
      async run() {
        return { response: "not-json" };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.deepEqual(route, {
    rule: "B",
  });
});

test("resolveIntentAndRule accepts valid router payload", async () => {
  const current = {
    year: 2026,
    month: 4,
    day: 19,
    isoDate: "2026-04-19",
    displayDate: "2026/04/19",
    weekday: "星期日",
    timezone: "Asia/Taipei",
  };
  const route = await resolveIntentAndRule(
    "幫我整理 effective-learning 的重點",
    current,
    "router instructions",
    {
      async run() {
        return { response: { rule: "B" } };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.deepEqual(route, {
    rule: "B",
  });
});

test("resolveIntentAndRule keeps rule D and defaults date", async () => {
  const current = {
    year: 2026,
    month: 4,
    day: 19,
    isoDate: "2026-04-19",
    displayDate: "2026/04/19",
    weekday: "星期日",
    timezone: "Asia/Taipei",
  };
  const route = await resolveIntentAndRule(
    "昨天我讀了什麼",
    current,
    "router instructions",
    {
      async run() {
        return {
          response: {
            rule: "D",
          },
        };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.deepEqual(route, {
    rule: "D",
    date: "2026-04-19",
  });
});

test("resolveIntentAndRule maps unknown rule to B", async () => {
  const current = {
    year: 2026,
    month: 4,
    day: 19,
    isoDate: "2026-04-19",
    displayDate: "2026/04/19",
    weekday: "星期日",
    timezone: "Asia/Taipei",
  };
  const route = await resolveIntentAndRule(
    "How to Learn Anything Faster Using Modern Research",
    current,
    "router instructions",
    {
      async run() {
        return {
          response: {
            rule: "X",
          },
        };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.deepEqual(route, {
    rule: "B",
  });
});

test("parseSummaryLookupDecision accepts summary lookup payload", () => {
  const parsed = parseSummaryLookupDecision('{"intent":"summary_lookup","path":"wiki/summaries/alpha.md"}');
  assert.deepEqual(parsed, { intent: "summary_lookup", path: "wiki/summaries/alpha.md" });
});

test("resolveRuleBSummaryPath falls back to only candidate on invalid lookup payload", async () => {
  const selectedPath = await resolveRuleBSummaryPath(
    "How to Learn Anything Faster Using Modern Research",
    "## Summaries\n- [how-to-learn-anything-faster-using-modern-research](wiki/summaries/how-to-learn-anything-faster-using-modern-research.md): summary",
    [
      {
        slug: "how-to-learn-anything-faster-using-modern-research",
        path: "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
        description: "summary",
      },
    ],
    {
      async run() {
        return { response: "not-json" };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.equal(
    selectedPath,
    "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
  );
});

test("resolveRuleBSummaryPath returns null for invalid payload with multiple candidates", async () => {
  const selectedPath = await resolveRuleBSummaryPath(
    "How to Learn Anything Faster Using Modern Research",
    "## Summaries\n- [alpha](wiki/summaries/alpha.md): alpha\n- [beta](wiki/summaries/beta.md): beta",
    [
      {
        slug: "alpha",
        path: "wiki/summaries/alpha.md",
        description: "alpha",
      },
      {
        slug: "beta",
        path: "wiki/summaries/beta.md",
        description: "beta",
      },
    ],
    {
      async run() {
        return { response: "not-json" };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.equal(selectedPath, null);
});

test("resolveRuleBSummaryPath falls back to only candidate on unsupported intent", async () => {
  const selectedPath = await resolveRuleBSummaryPath(
    "Harness Engineering：有時候語言模型不是不夠聰明，只是沒有人類好好引導",
    "## Summaries\n- [how-to-learn-anything-faster-using-modern-research](wiki/summaries/how-to-learn-anything-faster-using-modern-research.md): summary",
    [
      {
        slug: "how-to-learn-anything-faster-using-modern-research",
        path: "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
        description: "summary",
      },
    ],
    {
      async run() {
        return {
          response: {
            intent: "unsupported",
            path: "",
          },
        };
      },
    },
    "@cf/openai/gpt-oss-120b",
  );

  assert.equal(
    selectedPath,
    "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
  );
});

test("buildDateInfoFromIsoDate expands iso date into display fields", () => {
  const info = buildDateInfoFromIsoDate("2026-04-18", "Asia/Taipei");

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

test("runAiTextGeneration falls back from instructions to messages", async () => {
  const calls = [];
  const aiBinding = {
    async run(_model, payload) {
      calls.push(payload);
      if (calls.length === 1) {
        return { response: "" };
      }
      return { response: { reply: "這是 fallback 後的摘要" } };
    },
  };

  const result = await runAiTextGeneration({
    aiBinding,
    aiModel: "@cf/openai/gpt-oss-120b",
    instructions: "AGENTS.md router instructions",
    messages: [
      { role: "assistant", content: "system" },
      { role: "user", content: "user" },
    ],
    responseFormat: buildSummaryReplyResponseFormat(),
    extractText: extractSummaryReplyFromResult,
    temperature: 0.2,
    timeoutMs: 1000,
    timeoutMessage: "timed out",
    eventBase: "ai.summary",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "這是 fallback 後的摘要");
  assert.equal(result.mode, "messages_fallback");
  assert.ok("instructions" in calls[0]);
  assert.ok(Array.isArray(calls[1].messages));
});

test("runAiTextGeneration falls back when primary call times out", async () => {
  const calls = [];
  const aiBinding = {
    async run(_model, payload) {
      calls.push(payload);
      if (calls.length === 1) {
        return new Promise(() => {});
      }
      return { response: { reply: "這是 timeout 後的 fallback 摘要" } };
    },
  };

  const result = await runAiTextGeneration({
    aiBinding,
    aiModel: "@cf/openai/gpt-oss-120b",
    instructions: "AGENTS.md router instructions",
    messages: [
      { role: "assistant", content: "system" },
      { role: "user", content: "user" },
    ],
    responseFormat: buildSummaryReplyResponseFormat(),
    extractText: extractSummaryReplyFromResult,
    temperature: 0.2,
    timeoutMs: 10,
    timeoutMessage: "timed out",
    eventBase: "ai.summary",
  });

  assert.equal(calls.length, 2);
  assert.equal(result.text, "這是 timeout 後的 fallback 摘要");
  assert.equal(result.mode, "messages_timeout_fallback");
});

test("summarizeReadingLog returns shared summary output", async () => {
  const currentDateInfo = {
    year: 2026,
    month: 4,
    day: 19,
    isoDate: "2026-04-19",
    displayDate: "2026/04/19",
    weekday: "星期日",
    timezone: "Asia/Taipei",
  };
  const targetDateInfo = buildDateInfoFromIsoDate("2026-04-18", "Asia/Taipei");
  const aiBinding = {
    async run() {
      return { response: { reply: "2026/04/18 你讀了 1 篇文章，重點是要直接用 summary 內的具體內容。" } };
    },
  };

  const summary = await summarizeReadingLog(
    [
      {
        path: "wiki/summaries/test.md",
        content: "# Test\n\nSchema retry notes.",
      },
    ],
    currentDateInfo,
    targetDateInfo,
    aiBinding,
    "@cf/openai/gpt-oss-120b",
    {
      timeoutMs: 1000,
      ruleContent: "只輸出摘要。",
      unresolvedReferences: [],
    },
    {},
  );

  assert.match(summary, /具體內容/);
});
