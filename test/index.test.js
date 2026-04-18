import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  buildDateVariants,
  clampLineText,
  extractAiText,
  extractTodayLog,
  getTodayInfo,
  timingSafeEqual,
  verifyLineSignature,
} from "../src/index.js";

test("buildDateVariants includes common date formats", () => {
  const variants = buildDateVariants({ year: 2026, month: 4, day: 19 });

  assert.ok(variants.includes("2026-04-19"));
  assert.ok(variants.includes("2026/4/19"));
  assert.ok(variants.includes("2026年4月19日"));
});

test("extractTodayLog returns dated section until next heading", () => {
  const logContent = `
# 2026-04-19
- Read chapter 1
- Read chapter 2

# 2026-04-18
- Old content
`.trim();

  const result = extractTodayLog(logContent, { year: 2026, month: 4, day: 19 });
  assert.equal(result, "# 2026-04-19\n- Read chapter 1\n- Read chapter 2");
});

test("extractTodayLog falls back to paragraphs when no heading sections exist", () => {
  const logContent = `
2026/04/19 閱讀了 Cloudflare Workers 文件，重點是 AI binding。

2026/04/18 舊紀錄。
`.trim();

  const result = extractTodayLog(logContent, { year: 2026, month: 4, day: 19 });
  assert.match(result, /Cloudflare Workers/);
  assert.doesNotMatch(result, /舊紀錄/);
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

test("getTodayInfo returns timezone based date parts", () => {
  const info = getTodayInfo("Asia/Taipei");

  assert.match(info.isoDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(info.timezone, "Asia/Taipei");
});
