export function encodeGithubContent(text) {
    return Buffer.from(text, "utf8").toString("base64");
}

export function decodeGithubContent(text) {
    return Buffer.from(text, "base64").toString("utf8");
}

export function createJsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export async function withMockedFetch(mockFetch, callback) {
    const originalFetch = global.fetch;
    global.fetch = mockFetch;
    try {
        return await callback();
    } finally {
        global.fetch = originalFetch;
    }
}

export function createGithubConfig(overrides = {}) {
    return {
        githubOwner: "owner",
        githubRepo: "repo",
        githubRef: "main",
        githubToken: "token",
        ...overrides,
    };
}

export function createCurrentDateInfo(overrides = {}) {
    return {
        year: 2026,
        month: 4,
        day: 19,
        isoDate: "2026-04-19",
        displayDate: "2026/04/19",
        weekday: "星期日",
        timezone: "Asia/Taipei",
        ...overrides,
    };
}

export function createQueryAgentOptions(overrides = {}) {
    return {
        userPrompt: "幫我整理今天的重點",
        aiBinding: {
            async run() {
                return { response: "這是純文字摘要" };
            },
        },
        aiModel: "@cf/openai/gpt-oss-20b",
        config: createGithubConfig(),
        trace: {},
        timeoutMs: 5000,
        currentDateInfo: createCurrentDateInfo(),
        ...overrides,
    };
}

export function createToolContext(overrides = {}) {
    return {
        config: createGithubConfig(),
        trace: {},
        logInfo: () => {},
        ...overrides,
    };
}

export function createBaseRuntimeEnv(overrides = {}) {
    return {
        TELEGRAM_BOT_TOKEN: "telegram-token",
        GITHUB_OWNER: "owner",
        GITHUB_REPO: "repo",
        GITHUB_TOKEN: "github-token",
        ...overrides,
    };
}

export function createScheduledEnv(overrides = {}) {
    return createBaseRuntimeEnv({
        TELEGRAM_CHAT_ID: "123456789",
        APP_TIMEZONE: "Asia/Taipei",
        AI_MODEL: "@cf/openai/gpt-oss-20b",
        LLM_WIKI_QUEUE: {
            async send() {},
        },
        ...overrides,
    });
}
