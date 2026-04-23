export function clampChatText(text) {
    const normalized = String(text || "").trim();
    const maxLength = 3500;
    if (!normalized) {
        return "目前暫時無法提供內容，請稍後再試。";
    }
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 14)}\n\n[內容已截斷]`;
}

export function buildUserErrorMessage(error, currentDateInfo) {
    const message = error instanceof Error ? error.message : String(error);

    if (isWorkersAiDailyLimitError(message)) {
        return "目前 Workers AI 今日免費額度已用完，請稍後再試。";
    }

    if (message.includes("Unsupported reading lookup request")) {
        return "請用像「今天我讀了什麼」、「昨天我讀了什麼」或「4/18 我讀了什麼」這樣的方式查詢。";
    }

    if (message.includes("GitHub file not found")) {
        return "找不到閱讀紀錄檔案，請確認 GitHub 路徑設定。";
    }

    if (message.includes("GitHub authentication failed")) {
        return "目前無法讀取 GitHub 私有內容，請檢查 GitHub Token。";
    }

    if (message.includes("summary timed out")) {
        return "摘要整理逾時，請稍後再試，或改查較短時間範圍。";
    }

    if (message.includes("Workers AI")) {
        return "找到相關日期後，暫時無法完成整理，請稍後再試。";
    }

    if (currentDateInfo) {
        return `目前無法處理這次查詢。今天是 ${currentDateInfo.displayDate} ${currentDateInfo.weekday}，請稍後再試。`;
    }

    return "目前暫時無法處理這個指令，請稍後再試。";
}

function isWorkersAiDailyLimitError(message) {
    return (
        message.includes("4006") &&
        (message.includes("daily free allocation") ||
            message.includes("10,000 neurons") ||
            message.includes("Workers AI"))
    );
}
