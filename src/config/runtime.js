export const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
export const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
export const AGENTS_PATH = "AGENTS.md";
export const DEFAULT_AI_MODEL = "@cf/openai/gpt-oss-20b";
export function buildScheduledQuery(currentDateInfo) {
    return "排程任務需要把當天整理結果寫入知識庫";
}
export const EVENT_TIMEOUT_MS = 120000;

export function getRuntimeConfig(env) {
    const required = [
        "LINE_CHANNEL_ACCESS_TOKEN",
        "LINE_CHANNEL_SECRET",
        "GITHUB_OWNER",
        "GITHUB_REPO",
        "GITHUB_TOKEN",
    ];

    for (const key of required) {
        if (!env[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }

    return {
        githubOwner: env.GITHUB_OWNER,
        githubRepo: env.GITHUB_REPO,
        githubRef: env.GITHUB_REF || "main",
        githubToken: env.GITHUB_TOKEN,
        timezone: env.APP_TIMEZONE || "Asia/Taipei",
        lineTargetUserId: env.LINE_TARGET_USER_ID || "",
        summaryAiModel:
            env.SUMMARY_AI_MODEL ||
            env.AI_MODEL ||
            DEFAULT_AI_MODEL,
        eventTimeoutMs: EVENT_TIMEOUT_MS,
    };
}

export function requireLineTargetUserId(config) {
    if (!config.lineTargetUserId) {
        throw new Error(
            "Missing required environment variable: LINE_TARGET_USER_ID",
        );
    }
    return config.lineTargetUserId;
}

export function getScheduledDate(controller) {
    const scheduledTime = Number(controller?.scheduledTime);
    if (Number.isFinite(scheduledTime) && scheduledTime > 0) {
        return new Date(scheduledTime);
    }
    return new Date();
}

export function maskLineUserId(userId) {
    const normalized = String(userId || "");
    if (normalized.length <= 8) {
        return normalized;
    }
    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
