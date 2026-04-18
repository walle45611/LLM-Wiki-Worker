export function buildDateResolutionSystemPrompt(currentDateInfo) {
    return `你是日期語意解析器。你的工作是從使用者的繁體中文訊息中判斷他想查詢哪一天的閱讀紀錄。

今天的基準日期資訊如下：
- 西元年份：${currentDateInfo.year}
- 日期：${currentDateInfo.displayDate}
- 星期：${currentDateInfo.weekday}
- 時區：${currentDateInfo.timezone}

請依據上面的基準日期理解相對時間，例如「昨天」、「前天」、「大前天」。
如果使用者只寫月日，例如「4/18 我讀了什麼」，優先視為今年的 4 月 18 日。
只有在使用者明確表達是查詢某一天讀了什麼時，才回傳成功結果。
回覆必須是單一 JSON，不要加上任何額外文字或 Markdown。

JSON 格式如下：
{"intent":"reading_lookup","date":"YYYY-MM-DD"}

若無法判斷或不是查詢閱讀紀錄，請回：
{"intent":"unsupported"}`;
}

export function buildDateResolutionUserPrompt(userText) {
    return `請解析這句話要查詢的日期：${userText}`;
}

export function buildDateResolutionAssistantPrompt() {
    return '{"intent":"reading_lookup","date":"YYYY-MM-DD"}';
}

export function buildSummarySystemPrompt(
    currentDateInfo,
    agentsContent,
    queryRulesContent,
) {
    return `你是閱讀紀錄整理助手。請用繁體中文輸出精簡摘要，聚焦指定日期讀了哪些主題、重點與可能的收穫。不要捏造未出現在原文中的資訊。

今天的基準日期資訊如下：
- 西元年份：${currentDateInfo.year}
- 日期：${currentDateInfo.displayDate}
- 星期：${currentDateInfo.weekday}
- 時區：${currentDateInfo.timezone}

以下是專案角色定義（AGENTS.md）：
${agentsContent}

以下是查詢流程規範（wiki/rules/query-rules.md）：
${queryRulesContent}`;
}

export function buildSummaryUserPrompt(
    summaryFiles,
    targetDateInfo,
    unresolvedReferences = [],
) {
    const filePayload = summaryFiles
        .map(
            (file) =>
                `--- FILE: ${file.path} ---\n${file.content.trim() || "(empty)"}`,
        )
        .join("\n\n");
    const unresolvedText =
        unresolvedReferences.length > 0
            ? `\n\n另外有以下參照無法定位為 summary 檔案（可忽略，不要猜測內容）：\n${unresolvedReferences.map((item) => `- ${item}`).join("\n")}`
            : "";

    return `使用者想查詢的日期：${targetDateInfo.displayDate}
該日期星期：${targetDateInfo.weekday}
時區：${targetDateInfo.timezone}

以下是該日期對應的 summaries 檔案內容，請整理成適合 LINE 回覆的一段摘要：

${filePayload}${unresolvedText}`;
}
