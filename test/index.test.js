import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  app,
  buildDateInfoFromIsoDate,
  buildDateVariants,
  clampLineText,
  extractAiText,
  extractLogForDate,
  extractSummaryReferencesFromLog,
  getCurrentDateInfo,
  normalizeWikiPath,
  parseDateResolution,
  parseSummaryIndex,
  resolveSummaryPathsForDate,
  timingSafeEqual,
  verifyLineSignature,
} from "../src/index.js";

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

test("parseDateResolution accepts reading lookup payload", () => {
  const parsed = parseDateResolution('{"intent":"reading_lookup","date":"2026-04-18"}');

  assert.deepEqual(parsed, {
    intent: "reading_lookup",
    date: "2026-04-18",
  });
});

test("parseDateResolution rejects invalid date format", () => {
  assert.throws(
    () => parseDateResolution('{"intent":"reading_lookup","date":"2026/04/18"}'),
    /invalid date format/i,
  );
});

test("buildDateInfoFromIsoDate expands iso date into display fields", () => {
  const info = buildDateInfoFromIsoDate("2026-04-18", "Asia/Taipei");

  assert.equal(info.displayDate, "2026/04/18");
  assert.equal(info.weekday, "星期六");
  assert.equal(info.timezone, "Asia/Taipei");
});

test("extractAiText supports common Workers AI shapes", () => {
  assert.equal(extractAiText({ response: "summary" }), "summary");
  assert.equal(
    extractAiText({ choices: [{ message: { content: "choice summary" } }] }),
    "choice summary",
  );
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
