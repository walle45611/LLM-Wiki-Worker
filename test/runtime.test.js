import test from "node:test";
import assert from "node:assert/strict";

import { clampChatText, buildUserErrorMessage } from "../src/chat/messages.js";
import { getRuntimeConfig, requireTelegramWebhookSecret } from "../src/config/runtime.js";
import { toJsonPreview } from "../src/logger.js";
import { createBaseRuntimeEnv } from "../testing/helpers.js";

test("toJsonPreview truncates long serialized payloads", () => {
    const preview = toJsonPreview({
        content: "x".repeat(600),
        nested: { value: "y".repeat(100) },
    });

    assert.ok(preview.length <= 283);
    assert.match(preview, /\.\.\.$/);
});

test("requireTelegramWebhookSecret returns configured secret", () => {
    assert.equal(
        requireTelegramWebhookSecret({
            TELEGRAM_WEBHOOK_SECRET: "expected-secret",
        }),
        "expected-secret",
    );
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

test("getRuntimeConfig uses default timeout and accepts env override", () => {
    const defaultConfig = getRuntimeConfig(createBaseRuntimeEnv());
    assert.equal(defaultConfig.eventTimeoutMs, 120000);

    const overriddenConfig = getRuntimeConfig(
        createBaseRuntimeEnv({ EVENT_TIMEOUT_MS: "180000" }),
    );
    assert.equal(overriddenConfig.eventTimeoutMs, 180000);

    const invalidConfig = getRuntimeConfig(
        createBaseRuntimeEnv({ EVENT_TIMEOUT_MS: "invalid" }),
    );
    assert.equal(invalidConfig.eventTimeoutMs, 120000);
});
