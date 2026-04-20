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
    const tools = buildQueryAgentTools({ enableFileTree: false });
    const instructions = String(agentPrompt || "").trim();
    const systemPrompt = `【可用工具】
1) get_file：讀取單一檔案內容。參數：path（必填）

【任務】
你只能根據 wiki/ 內實際讀到的內容回答使用者問題，不得引用或推論 wiki/ 以外的資訊，也不得讀取 raw/。

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
1) 只能使用 get_file 讀取檔案
2) 不得自行猜測檔名或路徑（例如自行假設 wiki/reading-log.md 存在）
3) 後續只能讀取下列來源中明確出現的 wiki/ 路徑：
   - 使用者 prompt 明確提到的路徑
   - router-rules.md 明確指出的路徑
   - 已讀 rule 明確指出的路徑
   - 已讀 wiki 檔案內明確列出的路徑
4) 若下一個檔案路徑在已讀內容中沒有被明確指出，必須直接說明路徑資訊不足，不得自行臆測
5) 若某個檔案路徑未曾在使用者 prompt、router-rules.md、已讀 rule、或已讀 wiki 檔案中明確出現，禁止呼叫 get_file 讀取該路徑

【回答規則】
1) 只根據實際讀到的 wiki/ 內容回答
2) 若資料不足、檔案不存在、或無法依規則完成判斷，必須直接說明，不得猜測

【輸出規則】
1) 最終輸出要適合 LINE 或手機通訊軟體閱讀
2) 保持精簡、清楚、好掃讀，避免文字牆
3) 可適度使用 emoji，但不要過量
4) 不要使用 Markdown 格式，例如 Markdown 標題語法（#、##）或分隔線（---）
5) 段落名稱改用【】表示，例如【4/18 知識庫回顧】`;
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
        instructionLength: instructions.length,
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
            instructionLength: instructions.length,
            instructionPreview: previewWithLimit(instructions, 1600),
            promptLength: systemPrompt.length,
            promptPreview: previewWithLimit(systemPrompt, 1600),
            inputMessages: buildInputMessageLog(conversation),
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
            const diagnostics = extractAiErrorDiagnostics(error);
            logWarn("ai.query_agent_round_failed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                errorName: error instanceof Error ? error.name : typeof error,
                errorMessage: error instanceof Error ? error.message : String(error),
                remainingMs,
                elapsedMs: Date.now() - startedAt,
                aiStatusCode: diagnostics.statusCode,
                aiResponseBodyPreview: diagnostics.responseBodyPreview,
                abortReason: diagnostics.abortReason,
                timeoutSource: diagnostics.timeoutSource,
            });
            if (isTimeoutLikeError(error)) {
                logInfo("ai.query_agent_loop_ended", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    reason: "timeout_fallback",
                    round: round + 1,
                    elapsedMs: Date.now() - startedAt,
                });
                return buildFastFallbackReply(userText);
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

        const toolCalls = normalizeToolCallsForRound(
            extractToolCalls(result),
            round,
        );
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
                    return buildFastFallbackReply(userText);
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
    return buildFastFallbackReply(userText);
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

function buildFastFallbackReply(userText) {
    const text = String(userText || "");
    if (/\d{1,2}\/\d{1,2}|今天|昨日|昨天|前天|\d{4}-\d{2}-\d{2}/.test(text)) {
        return "我有收到日期查詢，但目前整理流程逾時，請再試一次，或改問：今天讀了什麼。";
    }
    return "我有收到你的查詢，但目前整理流程逾時，請稍後再試。";
}

function isTimeoutLikeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out|timeout|AbortError/i.test(message);
}

function extractAiErrorDiagnostics(error) {
    const fallback = {
        statusCode: 0,
        responseBodyPreview: "",
        abortReason: "",
        timeoutSource: "",
    };
    if (!error || typeof error !== "object") {
        return fallback;
    }

    const statusCode =
        normalizeStatusCode(error.statusCode) ||
        normalizeStatusCode(error.status) ||
        normalizeStatusCode(error.response?.status) ||
        normalizeStatusCode(error.cause?.status) ||
        0;

    const responseBody =
        extractErrorBody(error.body) ||
        extractErrorBody(error.responseBody) ||
        extractErrorBody(error.response?.body) ||
        extractErrorBody(error.response?.data) ||
        extractErrorBody(error.cause?.body) ||
        extractErrorBody(error.cause?.response?.body) ||
        "";

    return {
        statusCode,
        responseBodyPreview: previewWithLimit(responseBody, 1600),
        abortReason: String(error.abortReason || error.cause?.abortReason || ""),
        timeoutSource: String(
            error.timeoutSource || error.cause?.timeoutSource || "",
        ),
    };
}

function normalizeStatusCode(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function extractErrorBody(value) {
    if (!value) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function buildInputMessageLog(messages) {
    return (messages || []).map((message, index) => ({
        index,
        role: message?.role || "",
        contentLength: String(message?.content || "").length,
        contentPreview: previewWithLimit(message?.content, 1600),
    }));
}

function previewWithLimit(text, maxLength) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
}

function normalizeToolCallsForRound(toolCalls, round) {
    if (round !== 0 || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        return toolCalls;
    }

    const firstCall = toolCalls[0];
    const name = getToolCallName(firstCall);
    const args = parseToolCallArguments(firstCall);
    const path = String(args?.path || "").trim();

    if (name === "get_file" && path === "wiki/rules/router-rules.md") {
        return toolCalls;
    }

    return [
        {
            ...firstCall,
            function: {
                name: "get_file",
                arguments: JSON.stringify({ path: "wiki/rules/router-rules.md" }),
            },
        },
    ];
}
