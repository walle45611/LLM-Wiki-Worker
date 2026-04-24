import test from "node:test";
import assert from "node:assert/strict";

import { fetchGithubFile } from "../src/github/client.js";
import {
    createGithubConfig,
    createJsonResponse,
    encodeGithubContent,
    withMockedFetch,
} from "../testing/helpers.js";

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
                    createGithubConfig(),
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
            const config = createGithubConfig();
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
