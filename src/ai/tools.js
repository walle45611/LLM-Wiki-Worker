import { fetchGithubFile, fetchGithubFileTree } from "../github/client.js";
const TOOL_GET_FILE_TREE = "get_file_tree";
const TOOL_GET_FILE = "get_file";

export function buildQueryAgentTools(options = {}) {
    const { enableFileTree = true } = options;
    const tools = [];
    if (enableFileTree) {
        tools.push({
            type: "function",
            function: {
                name: TOOL_GET_FILE_TREE,
                description:
                    "List repository files under a base path so you can discover which knowledge-base files to read next.",
                parameters: {
                    type: "object",
                    properties: {
                        base_path: { type: "string" },
                        max_depth: { type: "integer", minimum: 1, maximum: 4 },
                    },
                    additionalProperties: false,
                },
            },
        });
    }
    tools.push({
        type: "function",
        function: {
            name: TOOL_GET_FILE,
            description:
                "Read a repository text file by path so you can use its content to answer the user.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
            },
        },
    });
    return tools;
}

export function extractToolCalls(result) {
    const candidates = [
        result?.tool_calls,
        result?.response?.tool_calls,
        result?.result?.tool_calls,
        result?.result?.response?.tool_calls,
        result?.choices?.[0]?.message?.tool_calls,
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) {
            return candidate;
        }
    }
    return [];
}

export function getToolCallName(toolCall) {
    return toolCall?.function?.name || toolCall?.name || "";
}

export function getToolCallId(toolCall, index) {
    return toolCall?.id || `tool_call_${index + 1}`;
}

export function parseToolCallArguments(toolCall) {
    const args = toolCall?.function?.arguments ?? toolCall?.arguments;
    if (!args) {
        return {};
    }
    if (typeof args === "object") {
        return args;
    }
    if (typeof args === "string") {
        return JSON.parse(args);
    }
    throw new Error("Workers AI returned invalid tool arguments");
}

export function buildAssistantToolCallMessage(toolCalls) {
    return {
        role: "assistant",
        content: "",
        tool_calls: toolCalls.map((toolCall, index) => {
            const name = getToolCallName(toolCall);
            const args =
                toolCall?.function?.arguments ?? toolCall?.arguments ?? "{}";
            return {
                id: getToolCallId(toolCall, index),
                type: "function",
                function: {
                    name,
                    arguments:
                        typeof args === "string" ? args : JSON.stringify(args),
                },
            };
        }),
    };
}

export async function executeQueryToolCall(name, args, context) {
    if (name === TOOL_GET_FILE_TREE) {
        return getFileTreeTool(args, context);
    }
    if (name === TOOL_GET_FILE) {
        return getFileTool(args, context);
    }
    throw new Error(`Unsupported query tool call: ${name}`);
}

async function getFileTreeTool(args, { config, trace, logInfo }) {
    const basePath = normalizePath(args?.base_path || "");
    const maxDepth = Math.max(1, Math.min(Number(args?.max_depth || 2), 2));
    logInfo("tool.get_file_tree_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        args: {
            base_path: basePath,
            max_depth: maxDepth,
        },
    });
    const tree = await fetchGithubFileTree(config, basePath, maxDepth, { logInfo });

    logInfo("tool.get_file_tree_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        basePath,
        total: tree.length,
    });
    const result = { basePath, tree };
    logInfo("tool.get_file_tree_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result).slice(0, 1200),
    });
    return result;
}

async function getFileTool(args, { config, trace, logInfo }) {
    const path = normalizePath(args?.path || "");
    logInfo("tool.get_file_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        args: {
            path,
        },
    });
    if (!path) {
        throw new Error("Tool argument path is required");
    }
    const content = await fetchGithubFile(config, path, { logInfo });
    logInfo("tool.get_file_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        path,
        length: content.length,
    });
    const result = { path, content: compactToolText(content) };
    logInfo("tool.get_file_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result).slice(0, 1200),
    });
    return result;
}

function normalizePath(path) {
    return String(path || "")
        .replace(/^\/+/, "")
        .trim();
}

function compactToolText(text) {
    return String(text || "").trim();
}
