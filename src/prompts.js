export const SUMMARY_SYSTEM_PROMPT =
    "你是閱讀紀錄整理助手。請用繁體中文輸出精簡摘要，聚焦今天讀了哪些主題、重點與可能的收穫。不要捏造未出現在原文中的資訊。";

export function buildSummaryUserPrompt(todayLog, todayInfo) {
    return `今天日期：${todayInfo.displayDate}
時區：${todayInfo.timezone}

以下是今天的閱讀紀錄，請整理成適合 LINE 回覆的一段摘要：

${todayLog}`;
}
