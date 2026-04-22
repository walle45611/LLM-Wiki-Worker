export const AGENTS_PATH = "AGENTS.md";
export const DEFAULT_AI_MODEL = "@cf/openai/gpt-oss-20b";
export const EVENT_TIMEOUT_MS = 120000;

export function buildScheduledQuery(_currentDateInfo) {
    return "排程任務需要把當天整理結果寫入知識庫";
}

export function getRuntimeConfig(env) {
    const required = [
        "TELEGRAM_BOT_TOKEN",
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
        telegramBotToken: env.TELEGRAM_BOT_TOKEN,
        telegramChatId: env.TELEGRAM_CHAT_ID || "",
        aiModel: env.AI_MODEL || DEFAULT_AI_MODEL,
        eventTimeoutMs: EVENT_TIMEOUT_MS,
    };
}

export function requireTelegramChatId(config) {
    if (!config.telegramChatId) {
        throw new Error("Missing required environment variable: TELEGRAM_CHAT_ID");
    }
    return config.telegramChatId;
}

export function getScheduledDate(controller) {
    const scheduledTime = Number(controller?.scheduledTime);
    if (Number.isFinite(scheduledTime) && scheduledTime > 0) {
        return new Date(scheduledTime);
    }
    return new Date();
}

export function maskChatId(chatId) {
    const normalized = String(chatId || "");
    if (normalized.length <= 8) {
        return normalized;
    }
    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
