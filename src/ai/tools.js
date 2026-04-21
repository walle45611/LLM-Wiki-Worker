import {
    fetchGithubFile,
    fetchGithubFileTree,
    upsertGithubFile,
} from "../github/client.js";
const TOOL_GET_FILE_TREE = "get_file_tree";
const TOOL_GET_FILE = "get_file";
const TOOL_UPSERT_FILE = "upsert_file";
const TOOL_APPEND_FILE = "append_file";
const TOOL_REPLACE_IN_FILE = "replace_in_file";

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
    tools.push({
        type: "function",
        function: {
            name: TOOL_UPSERT_FILE,
            description:
                "Create or update one repository file under wiki/ using the provided content.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                    commit_message: { type: "string" },
                },
                required: ["path", "content"],
                additionalProperties: false,
            },
        },
    });
    tools.push({
        type: "function",
        function: {
            name: TOOL_APPEND_FILE,
            description:
                "Append text to the end of one repository file under wiki/, creating it if needed.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                    commit_message: { type: "string" },
                },
                required: ["path", "content"],
                additionalProperties: false,
            },
        },
    });
    tools.push({
        type: "function",
        function: {
            name: TOOL_REPLACE_IN_FILE,
            description:
                "Replace one exact text fragment inside one repository file under wiki/.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    find: { type: "string" },
                    replace: { type: "string" },
                    commit_message: { type: "string" },
                },
                required: ["path", "find", "replace"],
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
        return parseJsonObjectSafely(args);
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
    if (name === TOOL_UPSERT_FILE) {
        return upsertFileTool(args, context);
    }
    if (name === TOOL_APPEND_FILE) {
        return appendFileTool(args, context);
    }
    if (name === TOOL_REPLACE_IN_FILE) {
        return replaceInFileTool(args, context);
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
    const result = { path, content: compactToolText(path, content) };
    logInfo("tool.get_file_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result).slice(0, 1200),
    });
    return result;
}

async function upsertFileTool(args, { config, trace, logInfo }) {
    const path = normalizePath(args?.path || "");
    const content = String(args?.content || "");
    const commitMessage = String(args?.commit_message || "").trim();
    logInfo("tool.upsert_file_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        args: {
            path,
            contentLength: content.length,
            hasCommitMessage: Boolean(commitMessage),
        },
    });
    assertWritableWikiPath(path);
    const payload = await upsertGithubFile(config, path, content, {
        logInfo,
        commitMessage: commitMessage || `chore: update ${path}`,
    });
    const result = {
        path,
        content_sha: payload?.content?.sha || "",
        commit_sha: payload?.commit?.sha || "",
        committed: true,
    };
    logInfo("tool.upsert_file_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        path,
        contentSha: result.content_sha,
        commitSha: result.commit_sha,
    });
    logInfo("tool.upsert_file_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result).slice(0, 1200),
    });
    return result;
}

async function appendFileTool(args, { config, trace, logInfo }) {
    const path = normalizePath(args?.path || "");
    const content = String(args?.content || "");
    const commitMessage = String(args?.commit_message || "").trim();
    logInfo("tool.append_file_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        args: {
            path,
            contentLength: content.length,
            hasCommitMessage: Boolean(commitMessage),
        },
    });
    assertWritableWikiPath(path);
    let existingContent = "";
    try {
        existingContent = await fetchGithubFile(config, path, { logInfo });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/GitHub file not found/i.test(message)) {
            throw error;
        }
    }
    const nextContent = `${existingContent}${content}`;
    const payload = await upsertGithubFile(config, path, nextContent, {
        logInfo,
        commitMessage: commitMessage || `chore: append ${path}`,
    });
    const result = {
        path,
        content_sha: payload?.content?.sha || "",
        commit_sha: payload?.commit?.sha || "",
        appended_length: content.length,
        committed: true,
    };
    logInfo("tool.append_file_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        path,
        appendedLength: content.length,
        contentSha: result.content_sha,
        commitSha: result.commit_sha,
    });
    logInfo("tool.append_file_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result),
    });
    return result;
}

async function replaceInFileTool(args, { config, trace, logInfo }) {
    const path = normalizePath(args?.path || "");
    const find = String(args?.find || "");
    const replace = String(args?.replace || "");
    const commitMessage = String(args?.commit_message || "").trim();
    logInfo("tool.replace_in_file_started", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        args: {
            path,
            findLength: find.length,
            replaceLength: replace.length,
            hasCommitMessage: Boolean(commitMessage),
        },
    });
    assertWritableWikiPath(path);
    if (!find) {
        throw new Error("Tool argument find is required");
    }
    const existingContent = await fetchGithubFile(config, path, { logInfo });
    if (!existingContent.includes(find)) {
        throw new Error(`replace_in_file could not find target text in ${path}`);
    }
    const nextContent = replaceFirst(existingContent, find, replace);
    const payload = await upsertGithubFile(config, path, nextContent, {
        logInfo,
        commitMessage: commitMessage || `chore: update ${path}`,
    });
    const result = {
        path,
        content_sha: payload?.content?.sha || "",
        commit_sha: payload?.commit?.sha || "",
        replaced: true,
        committed: true,
    };
    logInfo("tool.replace_in_file_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        path,
        contentSha: result.content_sha,
        commitSha: result.commit_sha,
    });
    logInfo("tool.replace_in_file_return", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        resultPreview: JSON.stringify(result),
    });
    return result;
}

function normalizePath(path) {
    return String(path || "")
        .replace(/^\/+/, "")
        .trim();
}

function assertWritableWikiPath(path) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
        throw new Error("Tool argument path is required");
    }
    if (!normalizedPath.startsWith("wiki/")) {
        throw new Error("upsert_file only allows writing under wiki/");
    }
}

function replaceFirst(text, find, replace) {
    const index = text.indexOf(find);
    if (index === -1) {
        return text;
    }
    return `${text.slice(0, index)}${replace}${text.slice(index + find.length)}`;
}

function parseJsonObjectSafely(text) {
    try {
        return JSON.parse(text);
    } catch {
        const trimmed = String(text || "").trim();
        const start = trimmed.indexOf("{");
        if (start === -1) {
            throw new Error("Workers AI returned invalid tool arguments");
        }

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = start; index < trimmed.length; index += 1) {
            const char = trimmed[index];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === "\\") {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === "{") {
                depth += 1;
                continue;
            }

            if (char === "}") {
                depth -= 1;
                if (depth === 0) {
                    return JSON.parse(trimmed.slice(start, index + 1));
                }
            }
        }

        throw new Error("Workers AI returned invalid tool arguments");
    }
}

function compactToolText(path, text) {
    return String(text || "").trim();
}
