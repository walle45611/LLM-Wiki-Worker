import test from "node:test";
import assert from "node:assert/strict";

import {
    buildQueryAgentTools,
    executeQueryToolCall,
    parseToolCallArguments,
} from "../src/ai/tools.js";
import {
    createCurrentDateInfo,
    createGithubConfig,
    createJsonResponse,
    createToolContext,
    decodeGithubContent,
    encodeGithubContent,
    withMockedFetch,
} from "../testing/helpers.js";

test("buildQueryAgentTools includes get_file_tree for query agent discovery", () => {
    const tools = buildQueryAgentTools({ enableFileTree: true });
    assert.ok(tools.some((tool) => tool.function?.name === "get_file_tree"));
    assert.ok(tools.some((tool) => tool.function?.name === "get_file"));
    assert.ok(tools.some((tool) => tool.function?.name === "get_now"));
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
                createToolContext(),
            );

            assert.match(result.content, /2026-04-20 still visible/);
            assert.equal(result.content, longLog);
        },
    );
});

test("executeQueryToolCall returns current date info", async () => {
    const result = await executeQueryToolCall(
        "get_now",
        {},
        createToolContext({
            currentDateInfo: {
                timezone: "Asia/Taipei",
                displayDate: "2026/04/23",
                weekday: "星期四",
                isoDate: "2026-04-23",
            },
        }),
    );

    assert.deepEqual(result, {
        timezone: "Asia/Taipei",
        displayDate: "2026/04/23",
        weekday: "星期四",
        isoDate: "2026-04-23",
    });
});

test("executeQueryToolCall keeps get_current_date_info compatibility", async () => {
    const result = await executeQueryToolCall(
        "get_current_date_info",
        {},
        createToolContext({
            currentDateInfo: {
                timezone: "Asia/Taipei",
                displayDate: "2026/04/23",
                weekday: "星期四",
                isoDate: "2026-04-23",
            },
        }),
    );

    assert.deepEqual(result.isoDate, "2026-04-23");
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
                createToolContext(),
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
                createToolContext(),
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
                createToolContext(),
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
            createToolContext(),
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
                createToolContext(),
            );

            assert.equal(result.path, "wiki/log.md");
            assert.equal(result.appended_length, 6);
            assert.equal(result.committed, true);
            const putRequest = requests.find(
                (request) => (request.options.method || "GET") === "PUT",
            );
            assert.ok(putRequest);
            const putBody = JSON.parse(putRequest.options.body);
            assert.equal(decodeGithubContent(putBody.content), "hello\nworld\n");
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
                createToolContext(),
            );

            assert.equal(result.path, "wiki/index.md");
            assert.equal(result.replaced, true);
            const putRequest = requests.find(
                (request) => (request.options.method || "GET") === "PUT",
            );
            assert.ok(putRequest);
            const putBody = JSON.parse(putRequest.options.body);
            assert.equal(decodeGithubContent(putBody.content), "alpha delta gamma");
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
            createToolContext(),
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
                    createToolContext({ config: createGithubConfig() }),
                ),
                /could not find target text/,
            );
        },
    );
});
