import {
    buildAssistantToolCallMessage,
    buildQueryAgentTools,
    executeQueryToolCall,
    extractToolCalls,
    getToolCallId,
    getToolCallName,
    parseToolCallArguments,
} from "../ai/tools.js";
import {
    containsForbiddenMarkdownReply,
    extractAiText,
    extractTelegramBlockPayloadFromResult,
    extractSummaryReplyFromResult,
} from "../ai/response.js";
import { logInfo, logWarn, toJsonPreview, toPreview } from "../logger.js";

const DEFAULT_MAX_TOKENS = 4096;
const QUERY_AGENT_TIMEOUT_REPLY = "目前整理流程逾時，請稍後再試。";
const QUERY_AGENT_KNOWLEDGE_TIMEOUT_REPLY =
    "目前讀取知識庫逾時，請稍後再試。";
const QUERY_AGENT_EMPTY_REPLY = "目前有找到資料，但暫時無法整理成可讀回覆，請稍後再試。";

export async function runQueryAgent({
    userPrompt,
    aiBinding,
    aiModel,
    config,
    trace = {},
    timeoutMs,
    currentDateInfo,
}) {
    assertAiBindingConfigured(aiBinding);
    const tools = buildQueryAgentTools({ enableFileTree: true });
    const systemPrompt = `
啟動規則：
1. 收到任務後，先使用 get_current_date_info 取得今天日期資訊
2. 這次任務要協助使用者處理 wiki 相關問題，並且遵守 rules 中的規定。
3. 再使用 get_file 讀 AGENTS.md
4. 再依 AGENTS.md 的要求，先讀 wiki/rules/router-rules.md 與必要 rules
5. 最終輸出前請先閱讀 wiki/rules/output-rules.md，並且這次輸出使用 JSON 回覆給使用者。
`.trim();
    const messages = [
        {
            role: "system",
            content: systemPrompt,
        },
        {
            role: "user",
            content: userPrompt,
        },
    ];

    const toolExecutionContext = {
        config,
        currentDateInfo,
        trace,
        logInfo,
    };

    const startedAt = Date.now();
    const deadlineMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    let conversation = [...messages];
    const maxRounds = 100;
    logInfo("ai.query_agent_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        model: aiModel,
        promptLength: systemPrompt.length,
        userTextPreview: toPreview(userPrompt),
        maxRounds,
        timeoutMs: deadlineMs,
    });

    for (let round = 0; round < maxRounds; round += 1) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = deadlineMs - elapsedMs;
        if (remainingMs <= 0) {
            logInfo("ai.query_agent_loop_ended", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                reason: "deadline_exceeded",
                round: round + 1,
                elapsedMs: Date.now() - startedAt,
            });
            return QUERY_AGENT_TIMEOUT_REPLY;
        }

        logInfo("ai.query_agent_request", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            model: aiModel,
            promptLength: systemPrompt.length,
            promptPreview: String(systemPrompt || ""),
            remainingMs,
        });

        let result = null;
        try {
            result = await runAiWithTimeout(
                aiBinding.run(aiModel, {
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
                errorMessage:
                    error instanceof Error ? error.message : String(error),
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
                return getTimeoutReplyForError(error);
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
            outputRawPreview: toJsonPreview(result),
            outputTextPreview: extractAiText(result),
        });

        const toolCalls = extractToolCalls(result);
        logInfo("ai.query_agent_round_completed", {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            round: round + 1,
            toolCallCount: toolCalls.length,
            outputRawPreview: toJsonPreview(result),
            elapsedMs: Date.now() - startedAt,
        });
        if (toolCalls.length === 0) {
            const payload = extractTelegramBlockPayloadFromResult(result);
            if (payload) {
                logInfo("ai.query_agent_completed", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    blockCount: payload.blocks.length,
                    preview: toPreview(JSON.stringify(payload)),
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
                return payload;
            }
            const fallbackReply = extractQueryAgentReply(result);
            if (!fallbackReply) {
                logWarn("ai.query_agent_empty_output", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    outputRawPreview: toJsonPreview(result),
                    elapsedMs: Date.now() - startedAt,
                });
                return QUERY_AGENT_EMPTY_REPLY;
            }
            if (containsForbiddenMarkdownReply(fallbackReply)) {
                logWarn("ai.query_agent_rejected_plain_text_fallback", {
                    requestId: trace.requestId,
                    eventIndex: trace.eventIndex,
                    preview: toPreview(fallbackReply),
                    elapsedMs: Date.now() - startedAt,
                });
                return QUERY_AGENT_EMPTY_REPLY;
            }
            logInfo("ai.query_agent_completed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                length: fallbackReply.length,
                preview: toPreview(fallbackReply),
                schemaRejected: true,
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
            return fallbackReply;
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
                argsPreview: toJsonPreview(args),
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
                    argsPreview: toJsonPreview(args),
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                });
                if (isTimeoutLikeError(error)) {
                    return getTimeoutReplyForError(error);
                }
                toolResult = {
                    error:
                        error instanceof Error ? error.message : String(error),
                    guidance:
                        "If the path may be missing .md or the filename may differ, try get_file again with .md or inspect the nearest parent directory with get_file_tree instead of scanning root.",
                };
            }
            logInfo("ai.query_agent_tool_call_completed", {
                requestId: trace.requestId,
                eventIndex: trace.eventIndex,
                round: round + 1,
                name,
                resultPreview: toJsonPreview(toolResult),
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

function getTimeoutReplyForError(error) {
    if (isGithubTimeoutLikeError(error)) {
        return QUERY_AGENT_KNOWLEDGE_TIMEOUT_REPLY;
    }
    return QUERY_AGENT_TIMEOUT_REPLY;
}

function isGithubTimeoutLikeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /GitHub fetch timed out|GitHub tree walk timed out/i.test(message);
}
