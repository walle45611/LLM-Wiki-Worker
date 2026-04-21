import { fetchGithubFile } from "../github/client.js";
import { logInfo, toPreview } from "../logger.js";
import { AGENTS_PATH } from "../config/runtime.js";
import { clampLineText } from "../line/messages.js";
import { runQueryAgent } from "./query-agent.js";

const DEFAULT_AGENT_PROMPT =
    "你在這個專案中的角色是知識庫維護者。請先讀取必要規則與檔案，再直接回答使用者。";

export async function buildLineQueryReply({
    text,
    currentDateInfo,
    config,
    env,
    trace,
    eventPrefix,
    totalStartedAt,
    timeoutMs,
}) {
    logInfo(`${eventPrefix}.user_query`, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        textPreview: toPreview(text),
        currentDate: currentDateInfo.isoDate,
    });

    const agentPrompt = await loadAgentPrompt(config, trace, eventPrefix);

    logInfo(`${eventPrefix}.agent_timeout_selected`, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        timeoutMs,
    });

    const userPrompt =
        eventPrefix === "scheduled_queue"
            ? text
            : `你是 LLM-Wiki-Worker，${text}`;

    const reply = await runQueryAgent({
        userPrompt,
        agentPrompt,
        aiBinding: env.AI,
        aiModel: config.aiModel,
        config,
        trace,
        timeoutMs,
        currentDateInfo,
    });
    const message = clampLineText(reply);
    logInfo(`${eventPrefix}.summary_generated`, {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        summaryLength: reply.length,
        summaryPreview: toPreview(reply),
        replyLength: message.length,
        totalElapsedMs: Date.now() - totalStartedAt,
        currentDate: currentDateInfo.isoDate,
    });
    return message;
}

async function loadAgentPrompt(config, trace, eventPrefix) {
    try {
        const content = await fetchGithubFile(config, AGENTS_PATH, { logInfo });
        logInfo(`${eventPrefix}.agents_loaded`, {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            length: content.length,
        });
        return content;
    } catch (error) {
        logInfo(`${eventPrefix}.agents_load_failed`, {
            requestId: trace.requestId,
            eventIndex: trace.eventIndex,
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
        return DEFAULT_AGENT_PROMPT;
    }
}
