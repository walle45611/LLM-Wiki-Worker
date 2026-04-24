import test from "node:test";
import assert from "node:assert/strict";

import { app, handleScheduledSummary } from "../src/index.js";
import { TELEGRAM_WEBHOOK_SECRET_HEADER } from "../src/config/runtime.js";
import {
    createBaseRuntimeEnv,
    createScheduledEnv,
} from "../testing/helpers.js";

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
            ...createBaseRuntimeEnv(),
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
            ...createBaseRuntimeEnv(),
            TELEGRAM_WEBHOOK_SECRET: "expected-secret",
            LLM_WIKI_QUEUE: { async send() {} },
        },
    );

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "Unauthorized");
});

test("handleScheduledSummary enqueues scheduled summary job", async () => {
    const queuedJobs = [];
    const env = createScheduledEnv({
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
        LLM_WIKI_QUEUE: {
            async send(payload) {
                queuedJobs.push(payload);
            },
        },
    });

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
    const env = createScheduledEnv({
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
        LLM_WIKI_QUEUE: {
            async send() {
                throw new Error("queue unavailable");
            },
        },
    });

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
    const env = createScheduledEnv({
        TELEGRAM_CHAT_ID: undefined,
        GITHUB_OWNER: "walle4561",
        GITHUB_REPO: "LLM-Wiki",
    });

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
