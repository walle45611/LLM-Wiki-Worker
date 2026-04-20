import {
    buildAssistantToolCallMessage,
    buildQueryAgentTools,
    executeQueryToolCall,
    extractToolCalls,
    getToolCallId,
    getToolCallName,
    parseToolCallArguments,
} from "../ai/tools.js";
import { extractAiText, extractSummaryReplyFromResult } from "../ai/response.js";
import { logInfo, logWarn, toPreview } from "../logger.js";

const DEFAULT_MAX_TOKENS = 2048;
const QUERY_AGENT_TIMEOUT_REPLY =
    "目前整理流程逾時，請稍後再試。";

export async function runQueryAgent({
    userText,
    agentPrompt,
    aiBinding,
    aiModel,
    config,
    trace = {},
    timeoutMs,
}) {
    assertAiBindingConfigured(aiBinding);
    const tools = buildQueryAgentTools({ enableFileTree: true });
    const instructions = String(agentPrompt || "").trim();
    const systemPrompt = `【可用工具】
1) get_file：讀取單一檔案內容。參數：path（必填）
2) get_file_tree：列出指定路徑下的檔案與資料夾。參數：base_path（必填）、max_depth（選填）


【強制流程】
1) 第一個工具呼叫必須是：
   get_file(path="wiki/rules/router-rules.md")
2) 讀取 router-rules.md 後，必須根據使用者 prompt 判斷對應 rule，並立刻使用 get_file 讀取該 rule（檔案位於 wiki/rules/*.md）
3) 在讀完 router-rules.md 與對應 rule 前，不得回答
4) 回答前，至少必須已讀取：
   - wiki/rules/router-rules.md
   - 一個對應 rule
   - 一個與問題直接相關的 wiki 檔案

【工具規則】
1) 你可以使用 get_file 讀取檔案，也可以在需要確認路徑時使用 get_file_tree
2) 不得自行猜測檔名或路徑（例如自行假設 wiki/reading-log.md 存在）
3) 後續只能讀取下列來源中明確出現的 wiki/ 或 raw/ 路徑：
   - 使用者 prompt 明確提到的路徑
   - router-rules.md 明確指出的路徑
   - 已讀 rule 明確指出的路徑
   - 已讀檔案內明確列出的路徑
   - get_file_tree 列出的路徑
4) 若下一個檔案路徑在已讀內容中沒有被明確指出，必須先用 get_file_tree 確認，或直接說明路徑資訊不足，不得自行臆測
5) 若某個檔案路徑未曾在使用者 prompt、router-rules.md、已讀 rule、已讀檔案、或 get_file_tree 結果中明確出現，禁止呼叫 get_file 讀取該路徑

【回答規則】
1) 只根據實際讀到的 wiki/ 內容回答
2) 若資料不足、檔案不存在、或無法依規則完成判斷，必須直接說明，不得猜測

【輸出規則】
1) 最終輸出只能是適合 LINE 或手機通訊軟體閱讀的純文字訊息
2) 保持精簡、清楚、好掃讀，避免文字牆
3) 可適度使用 emoji，但不要過量
4) 段落名稱一律改用【】表示，例如【4/18 知識庫回顧】
5) 禁止使用任何 Markdown 格式或樣式符號，包括但不限於：#、##、###、**粗體**、__粗體__、*斜體*、_斜體_、清單核取方塊、程式碼區塊標記、---、***、___
6) 禁止輸出任何結尾寒暄、邀請、延伸提問或客服式收尾，例如：
   - 如果您想更深入了解任何一篇，隨時告訴我！
   - 如果你想看更多，我可以再幫你整理
   - 有需要的話再跟我說
7) 結尾必須直接停在內容本身，不得附加多餘一句總結、提醒或邀請
8) 在輸出最終答案前，必須先自行逐項檢查格式是否合規
9) 若檢查後仍包含 #、##、###、**、__、*、_、---、***、___、Markdown 清單格式、結尾語、邀請語、或任何不屬於內容本身的補充句，禁止直接輸出，必須先改寫到完全移除後才能結束
10) 只有在確認最終文字完全不包含上述違規內容時，才能輸出最終答案`;
    const messages = [
        {
            role: "assistant",
            content: systemPrompt,
        },
        {
            role: "user",
            content: String(userText || "").trim(),
        },
    ];

    const toolExecutionContext = {
        config,
        trace,
        logInfo,
    };

    const startedAt = Date.now();
    const deadlineMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    let conversation = [...messages];
    const maxRounds = 12;
    logInfo("ai.query_agent_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        promptLength: systemPrompt.length,
        userTextPreview: toPreview(userText),
        maxRounds,
        timeoutMs: deadlineMs,
    });

    for (let round = 0; round < maxRounds; round += 1) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = deadlineMs - elapsedMs;
        if (remainingMs <= 0) {
            throw new Error("Workers AI query agent timed out");
        }

        logInfo("ai.query_agent_request", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            model: aiModel,
            instructionPreview: previewWithLimit(instructions, 1600),
            promptLength: systemPrompt.length,
            promptPreview: previewWithLimit(systemPrompt, 1600),
            remainingMs,
        });

        let result = null;
        try {
            result = await runAiWithTimeout(
                aiBinding.run(aiModel, {
                    ...(instructions ? { instructions } : {}),
                    messages: conversation,
                    tools,
                    max_tokens: DEFAULT_MAX_TOKENS,
                    temperature: 0.1,
                }),
                remainingMs,
                "Workers AI query agent timed out",
            );
        } catch (error) {
            logWarn("ai.query_agent_round_failed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                errorName: error instanceof Error ? error.name : typeof error,
                errorMessage: error instanceof Error ? error.message : String(error),
                remainingMs,
                elapsedMs: Date.now() - startedAt,
            });
            if (isTimeoutLikeError(error)) {
                logInfo("ai.query_agent_loop_ended", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    reason: "timeout_fallback",
                    round: round + 1,
                    elapsedMs: Date.now() - startedAt,
                });
                return QUERY_AGENT_TIMEOUT_REPLY;
            }
            logWarn("ai.query_agent_loop_ended", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                reason: "round_failed",
                round: round + 1,
                elapsedMs: Date.now() - startedAt,
            });
            throw error;
        }

        logInfo("ai.query_agent_response", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            outputRawPreview: previewWithLimit(JSON.stringify(result), 2200),
            outputTextPreview: previewWithLimit(extractAiText(result), 1600),
        });

        const toolCalls = extractToolCalls(result);
        logInfo("ai.query_agent_round_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            toolCallCount: toolCalls.length,
            outputRawPreview: toPreview(JSON.stringify(result)),
            elapsedMs: Date.now() - startedAt,
        });
        if (toolCalls.length === 0) {
            const reply = extractQueryAgentReply(result);
            if (!reply) {
                logWarn("ai.query_agent_empty_output", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    outputRawPreview: toPreview(JSON.stringify(result)),
                    elapsedMs: Date.now() - startedAt,
                });
                return "目前有找到資料，但暫時無法整理成可讀回覆，請稍後再試。";
            }
            logInfo("ai.query_agent_completed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                length: reply.length,
                preview: toPreview(reply),
                rounds: round + 1,
                elapsedMs: Date.now() - startedAt,
            });
            logInfo("ai.query_agent_loop_ended", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                reason: "completed",
                round: round + 1,
                elapsedMs: Date.now() - startedAt,
            });
            return reply;
        }

        const toolMessages = [];
        const assistantCallMessage = buildAssistantToolCallMessage(toolCalls);
        for (let index = 0; index < toolCalls.length; index += 1) {
            const toolCall = toolCalls[index];
            const name = getToolCallName(toolCall);
            const id = getToolCallId(toolCall, index);
            const args = parseToolCallArguments(toolCall);
            logInfo("ai.query_agent_tool_call_policy_check", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                name,
                violatesBestPractice: false,
                recommendation: "ok",
            });
            logInfo("ai.query_agent_tool_call_started", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                name,
                argsPreview: previewWithLimit(JSON.stringify(args), 1200),
            });
            let toolResult = null;
            try {
                toolResult = await executeQueryToolCall(
                    name,
                    args,
                    toolExecutionContext,
                );
            } catch (error) {
                logWarn("ai.query_agent_tool_call_failed", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    round: round + 1,
                    name,
                    argsPreview: previewWithLimit(JSON.stringify(args), 1200),
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
                if (isTimeoutLikeError(error)) {
                    return QUERY_AGENT_TIMEOUT_REPLY;
                }
                toolResult = {
                    error: error instanceof Error ? error.message : String(error),
                    guidance:
                        "If the path may be missing .md or the filename may differ, try get_file again with .md or inspect the nearest parent directory with get_file_tree instead of scanning root.",
                };
            }
            logInfo("ai.query_agent_tool_call_completed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                name,
                resultPreview: previewWithLimit(JSON.stringify(toolResult), 1200),
            });
            toolMessages.push({
                role: "tool",
                tool_call_id: id,
                name,
                content: JSON.stringify(toolResult),
            });
        }

        conversation = [...conversation, assistantCallMessage, ...toolMessages];
    }

    logWarn("ai.query_agent_max_rounds_reached", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        maxRounds,
        elapsedMs: Date.now() - startedAt,
    });
    logWarn("ai.query_agent_loop_ended", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        reason: "max_rounds_reached",
        round: maxRounds,
        elapsedMs: Date.now() - startedAt,
    });
    return QUERY_AGENT_TIMEOUT_REPLY;
}

function extractQueryAgentReply(result) {
    const structured = extractSummaryReplyFromResult(result).trim();
    if (structured) {
        return structured;
    }
    return extractAiText(result).trim();
}

function assertAiBindingConfigured(aiBinding) {
    if (!aiBinding?.run) {
        throw new Error("Workers AI binding is not configured");
    }
}

async function runAiWithTimeout(promise, timeoutMs, timeoutMessage) {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(timeoutMessage);
                error.name = "AbortError";
                error.timeoutSource = "runAiWithTimeout";
                error.abortReason = "deadline_exceeded";
                reject(error);
            }, timeoutMs);
        }),
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

function isTimeoutLikeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|timeout|AbortError/i.test(message);
}

function previewWithLimit(text, maxLength) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
}
