const MAX_SUMMARY_FILE_CHARS = 3200;
const MAX_INDEX_CHARS = 10000;

export function buildIntentRouterSystemPrompt(currentDateInfo) {
    return `你是 rule router。

今天日期：${currentDateInfo.displayDate} ${currentDateInfo.weekday} (${currentDateInfo.timezone})

IMPORTANT 規則：
- 有明確時間、日期、相對時間，且是在問某天讀了什麼：rule=D，並回 date（YYYY-MM-DD）
- 主題查詢、summary 查詢、概念整理：rule=B
- 無法判斷時：預設 rule=B

IMPORTANT 只回單一 JSON，不要加任何額外文字。`;
}

export function buildIntentRouterUserPrompt(userText) {
    return String(userText || "").trim();
}

export function buildSummaryUserPrompt(summaryFiles, context = {}) {
    const {
        targetDateInfo,
        userText = "",
        unresolvedReferences = [],
    } = context;
    const filePayload = summaryFiles
        .map(
            (file) =>
                `--- FILE: ${file.path} ---\n${compactText(file.content, MAX_SUMMARY_FILE_CHARS) || "(empty)"}`,
        )
        .join("\n\n");
    const unresolvedText =
        unresolvedReferences.length > 0
            ? `\n\n另外有以下參照無法定位為 summary 檔案（可忽略，不要猜測內容）：\n${unresolvedReferences.map((item) => `- ${item}`).join("\n")}`
            : "";
    const dateText = targetDateInfo
        ? `使用者想查詢的日期：${targetDateInfo.displayDate}
該日期星期：${targetDateInfo.weekday}
時區：${targetDateInfo.timezone}
`
        : "";
    const questionText = userText ? `使用者問題：${userText}\n` : "";

    return `${questionText}${dateText}
以下是這次任務可用的 summaries 檔案內容。請以 LINE 可直接閱讀的格式整理，優先引用 summary 裡的具體內容；若只有一篇，也請盡量整理出多個具體重點，不要縮成只有一句核心概念：

${filePayload}${unresolvedText}`;
}

export function buildSummaryLookupAssistantPrompt() {
    return `請使用 zh-TW 回覆。
輸出格式必須是單一 JSON 物件：{"intent":"summary_lookup","path":"wiki/summaries/xxx.md"} 或 {"intent":"unsupported","path":""}。
path 必須是 index 內容裡存在的 wiki/summaries/*.md 路徑。
不要輸出 Markdown code block、不要輸出額外說明、不要輸出其他欄位。`;
}

export function buildSummaryReplyAssistantPrompt() {
    return `請使用 zh-TW 回覆。
輸出格式必須是單一 JSON 物件：{"reply":"你的最終摘要"}。
不要輸出 Markdown code block、不要輸出額外說明、不要輸出其他欄位。`;
}

export function buildSummaryLookupUserPrompt(userText, indexContent) {
    const normalizedIndex = compactText(indexContent, MAX_INDEX_CHARS);
    return `使用者提問：
${userText}

以下是 wiki/index.md 的內容，請只從其中的 summaries 路徑挑選：
${normalizedIndex}`;
}

function compactText(text, maxLength) {
    const normalized = String(text || "").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}\n...(truncated)`;
}
