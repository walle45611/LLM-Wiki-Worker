import { fetchGithubFile, fetchGithubFileTree } from "../github/client.js";

const TOOL_SUMMARY_FILE_MAX_CHARS = 1800;
const TOOL_GET_FILE_TREE = "get_file_tree";
const TOOL_RESOLVE_RULE_FILE = "resolve_rule_file";
const TOOL_GET_FILE = "get_file";
const TOOL_GET_LOG_FOR_DATE = "get_log_for_date";
const TOOL_RESOLVE_SUMMARY_PATHS = "resolve_summary_paths";
const TOOL_GET_SUMMARY_FILES = "get_summary_files";

export function buildReadingFlowTools() {
    return [
        {
            type: "function",
            function: {
                name: TOOL_GET_FILE_TREE,
                description:
                    "List repository file tree under a base path so you can discover file locations before reading files.",
                parameters: {
                    type: "object",
                    properties: {
                        base_path: { type: "string" },
                        max_depth: { type: "integer", minimum: 1, maximum: 4 },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: TOOL_RESOLVE_RULE_FILE,
                description:
                    "Resolve a rule id like B or D into the matching rule file path from a wiki/rules file tree.",
                parameters: {
                    type: "object",
                    properties: {
                        rule: { type: "string" },
                        tree: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    path: { type: "string" },
                                    type: { type: "string" },
                                },
                                required: ["path", "type"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["rule", "tree"],
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: TOOL_GET_FILE,
                description:
                    "Read a markdown file from the repository by path.",
                parameters: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                    },
                    required: ["path"],
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: TOOL_GET_LOG_FOR_DATE,
                description:
                    "Read wiki/log.md and extract references for a specific YYYY-MM-DD date.",
                parameters: {
                    type: "object",
                    properties: {
                        date: {
                            type: "string",
                            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
                        },
                    },
                    required: ["date"],
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: TOOL_RESOLVE_SUMMARY_PATHS,
                description:
                    "Resolve raw references into wiki/summaries/*.md paths using wiki/index.md.",
                parameters: {
                    type: "object",
                    properties: {
                        references: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                    required: ["references"],
                    additionalProperties: false,
                },
            },
        },
        {
            type: "function",
            function: {
                name: TOOL_GET_SUMMARY_FILES,
                description:
                    "Fetch markdown content for resolved wiki/summaries/*.md paths.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                    required: ["paths"],
                    additionalProperties: false,
                },
            },
        },
    ];
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

export async function executeSummaryToolCall(name, args, context) {
    if (name === TOOL_GET_FILE_TREE) {
        return getFileTreeTool(args, context);
    }
    if (name === TOOL_RESOLVE_RULE_FILE) {
        return resolveRuleFileTool(args, context);
    }
    if (name === TOOL_GET_FILE) {
        return getFileTool(args, context);
    }
    if (name === TOOL_GET_LOG_FOR_DATE) {
        return getLogForDateTool(args, context);
    }
    if (name === TOOL_RESOLVE_SUMMARY_PATHS) {
        return resolveSummaryPathsTool(args, context);
    }
    if (name === TOOL_GET_SUMMARY_FILES) {
        return getSummaryFilesTool(args, context);
    }
    throw new Error(`Unsupported tool call: ${name}`);
}

async function getFileTreeTool(args, { config, trace, logInfo }) {
    const basePath = normalizePath(args?.base_path || "wiki/rules");
    const maxDepth = Number(args?.max_depth || 2);
    const tree = await fetchGithubFileTree(config, basePath, maxDepth);
    logInfo("tool.get_file_tree_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        basePath,
        total: tree.length,
    });
    return { basePath, tree };
}

async function getFileTool(args, { config, trace, logInfo }) {
    const path = normalizePath(args?.path || "");
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
    return { path, content: compactToolText(content, 1400) };
}

async function resolveRuleFileTool(args, { trace, logInfo }) {
    const rule = String(args?.rule || "")
        .trim()
        .toUpperCase();
    const tree = Array.isArray(args?.tree) ? args.tree : [];
    const files = tree
        .filter(
            (item) => item?.type === "file" && typeof item?.path === "string",
        )
        .map((item) => item.path);

    let path = "";
    if (rule === "B") {
        path = files.find((item) => /(^|\/)query-rules\.md$/i.test(item)) || "";
    } else if (rule === "D") {
        path =
            files.find((item) => /(^|\/)review-rules\.md$/i.test(item)) || "";
    }

    logInfo("tool.resolve_rule_file_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        rule,
        matched: Boolean(path),
        path,
    });

    return {
        rule,
        path,
        matched: Boolean(path),
    };
}

async function getLogForDateTool(
    args,
    {
        config,
        currentDateInfo,
        trace,
        buildDateInfoFromIsoDate,
        extractSummaryReferencesFromLog,
        extractLogForDate,
        logInfo,
    },
) {
    const date = String(args?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Tool argument date must be YYYY-MM-DD");
    }
    const targetDateInfo = buildDateInfoFromIsoDate(
        date,
        currentDateInfo.timezone,
    );
    const logContent = await fetchGithubFile(config, config.githubLogPath, {
        logInfo,
    });
    const references = extractSummaryReferencesFromLog(
        logContent,
        targetDateInfo,
    );
    const logSection = extractLogForDate(logContent, targetDateInfo);

    logInfo("tool.get_log_for_date_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        date,
        referenceCount: references.length,
    });

    return {
        date: targetDateInfo.isoDate,
        displayDate: targetDateInfo.displayDate,
        weekday: targetDateInfo.weekday,
        references,
        hasRecords: references.length > 0,
        logSection: compactToolText(logSection),
    };
}

async function resolveSummaryPathsTool(
    args,
    {
        config,
        trace,
        parseSummaryIndex,
        normalizeWikiPath,
        logInfo,
    },
) {
    const references = Array.isArray(args?.references)
        ? args.references
              .map((item) => String(item || "").trim())
              .filter(Boolean)
        : [];
    const indexContent = await fetchGithubFile(config, config.githubIndexPath, {
        logInfo,
    });
    const summaryMap = parseSummaryIndex(indexContent);
    const summaryPaths = [];
    const unresolvedReferences = [];

    for (const reference of references) {
        const normalized = normalizeWikiPath(reference);
        if (
            normalized.startsWith("wiki/summaries/") &&
            normalized.endsWith(".md")
        ) {
            summaryPaths.push(normalized);
            continue;
        }

        const slugCandidate =
            normalized.split("/").pop()?.replace(/\.md$/i, "") || "";
        const resolved = summaryMap.get(slugCandidate);
        if (resolved && resolved.startsWith("wiki/summaries/")) {
            summaryPaths.push(resolved);
        } else {
            unresolvedReferences.push(reference);
        }
    }

    const deduped = Array.from(new Set(summaryPaths));
    logInfo("tool.resolve_summary_paths_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        inputCount: references.length,
        resolvedCount: deduped.length,
        unresolvedCount: unresolvedReferences.length,
    });

    return {
        summaryPaths: deduped,
        unresolvedReferences,
    };
}

async function getSummaryFilesTool(
    args,
    { config, trace, fetchSummaryFiles, logInfo },
) {
    const paths = Array.isArray(args?.paths)
        ? args.paths.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
    const summarySources = await fetchSummaryFiles(paths, (path) =>
        fetchGithubFile(config, path, { logInfo }),
    );

    logInfo("tool.get_summary_files_completed", {
        requestId: trace.requestId,
        eventIndex: trace.eventIndex,
        requested: paths.length,
        found: summarySources.files.length,
        missing: summarySources.missingPaths.length,
    });

    return {
        files: summarySources.files.map((file) => ({
            path: file.path,
            content: compactToolText(file.content),
        })),
        missingPaths: summarySources.missingPaths,
    };
}

function normalizePath(path) {
    return String(path || "")
        .replace(/^\/+/, "")
        .trim();
}

function compactToolText(text, maxLength = TOOL_SUMMARY_FILE_MAX_CHARS) {
    const normalized = String(text || "").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}\n...(truncated)`;
}
