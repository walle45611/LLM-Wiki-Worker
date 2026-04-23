import { Octokit } from "octokit";

const GITHUB_FETCH_TIMEOUT_MS = 15000;
const GITHUB_TREE_TOTAL_TIMEOUT_MS = 12000;
const GITHUB_TREE_MAX_ENTRIES = 400;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "llmwikiworker";

export async function fetchGithubFile(config, filePath, options = {}) {
    const { logInfo, timeoutMs } = options;
    const requestTimeoutMs = timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
    const octokit = createOctokit(config, requestTimeoutMs);
    logInfo?.("github.fetch_started", {
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: config.githubRef,
        path: filePath,
    });

    const startedAt = Date.now();
    let response = null;
    try {
        response = await requestGithubContents(octokit, config, filePath);
    } catch (error) {
        logInfo?.("github.fetch_failed", {
            path: filePath,
            elapsedMs: Date.now() - startedAt,
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
        throw mapGithubFetchError(error, filePath, requestTimeoutMs);
    }
    logInfo?.("github.fetch_response", {
        path: filePath,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
    });

    const payload = response.data;
    if (!payload?.content) {
        throw new Error("GitHub API returned empty file content");
    }

    const decoded = decodeGithubContent(payload.content, payload.encoding);
    logInfo?.("github.fetch_decoded", {
        path: filePath,
        length: decoded.length,
    });
    return decoded;
}

export async function upsertGithubFile(
    config,
    filePath,
    content,
    options = {},
) {
    const { logInfo, commitMessage } = options;
    const message =
        String(commitMessage || "").trim() || `chore: update ${filePath}`;
    const octokit = createOctokit(config, GITHUB_FETCH_TIMEOUT_MS);

    let sha = null;
    try {
        const existingResponse = await requestGithubContents(
            octokit,
            config,
            filePath,
        );
        sha =
            typeof existingResponse.data?.sha === "string"
                ? existingResponse.data.sha
                : null;
    } catch (error) {
        const status = getGithubStatus(error);
        if (status !== 404) {
            logInfo?.("github.upsert_lookup_failed", {
                path: filePath,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            });
        }
    }

    const params = {
        owner: config.githubOwner,
        repo: config.githubRepo,
        path: filePath,
        message,
        content: encodeGithubContent(content),
        branch: config.githubRef,
    };
    if (sha) {
        params.sha = sha;
    }

    logInfo?.("github.upsert_started", {
        path: filePath,
        hasExistingSha: Boolean(sha),
        message,
    });

    let response = null;
    try {
        response = await octokit.request(
            "PUT /repos/{owner}/{repo}/contents/{path}",
            params,
        );
    } catch (error) {
        const status = getGithubStatus(error);
        const messageText = extractGithubErrorText(error);
        throw new Error(
            `GitHub upsert failed with status ${status || "unknown"}: ${messageText}`,
        );
    }

    const payload = response.data;
    logInfo?.("github.upsert_completed", {
        path: filePath,
        contentSha: payload?.content?.sha || "",
    });
    return payload;
}

export async function fetchGithubFileTree(
    config,
    basePath,
    maxDepth,
    options = {},
) {
    const { logInfo } = options;
    const entries = [];
    const startedAt = Date.now();
    const safeBasePath = normalizePath(basePath);
    const safeMaxDepth = Math.max(1, Math.min(Number(maxDepth || 2), 2));
    logInfo?.("github.fetch_tree_started", {
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: config.githubRef,
        basePath: safeBasePath,
        maxDepth: safeMaxDepth,
    });
    try {
        await walkGithubDir(
            config,
            safeBasePath,
            0,
            safeMaxDepth,
            entries,
            logInfo,
            startedAt,
        );
        logInfo?.("github.fetch_tree_response", {
            basePath: safeBasePath,
            maxDepth: safeMaxDepth,
            entriesCount: entries.length,
            elapsedMs: Date.now() - startedAt,
        });
    } catch (error) {
        logInfo?.("github.fetch_tree_failed", {
            basePath: safeBasePath,
            maxDepth: safeMaxDepth,
            elapsedMs: Date.now() - startedAt,
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    return entries;
}

async function walkGithubDir(
    config,
    path,
    depth,
    maxDepth,
    output,
    logInfo,
    startedAt,
) {
    if (Date.now() - startedAt > GITHUB_TREE_TOTAL_TIMEOUT_MS) {
        throw new Error(
            `GitHub tree walk timed out after ${GITHUB_TREE_TOTAL_TIMEOUT_MS}ms`,
        );
    }
    if (output.length >= GITHUB_TREE_MAX_ENTRIES) {
        throw new Error(
            `GitHub tree walk exceeded ${GITHUB_TREE_MAX_ENTRIES} entries`,
        );
    }
    logInfo?.("github.fetch_tree_walk_started", {
        path,
        depth,
        elapsedMs: Date.now() - startedAt,
    });

    const octokit = createOctokit(config, GITHUB_FETCH_TIMEOUT_MS);
    const response = await requestGithubContents(octokit, config, path);
    const payload = response.data;
    const items = Array.isArray(payload) ? payload : [];
    logInfo?.("github.fetch_tree_walk_response", {
        path,
        depth,
        itemCount: items.length,
        elapsedMs: Date.now() - startedAt,
    });
    for (const item of items) {
        output.push({ path: item.path, type: item.type });
        if (item.type === "dir" && depth + 1 < maxDepth) {
            await walkGithubDir(
                config,
                item.path,
                depth + 1,
                maxDepth,
                output,
                logInfo,
                startedAt,
            );
        }
    }
}

function normalizePath(path) {
    return String(path || "")
        .replace(/^\/+/, "")
        .trim();
}

function createOctokit(config, timeoutMs = GITHUB_FETCH_TIMEOUT_MS) {
    return new Octokit({
        auth: config.githubToken,
        userAgent: GITHUB_USER_AGENT,
        request: {
            fetch: createFetchWithTimeout(timeoutMs),
            headers: {
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
            },
        },
    });
}

function createFetchWithTimeout(timeoutMs) {
    return async function timedFetch(url, init = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const upstreamSignal = init.signal;
        let cleanup = null;

        if (upstreamSignal) {
            if (upstreamSignal.aborted) {
                controller.abort(upstreamSignal.reason);
            } else {
                cleanup = () => controller.abort(upstreamSignal.reason);
                upstreamSignal.addEventListener("abort", cleanup, {
                    once: true,
                });
            }
        }

        try {
            return await fetch(url, {
                ...init,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
            if (cleanup && upstreamSignal) {
                upstreamSignal.removeEventListener("abort", cleanup);
            }
        }
    };
}

async function requestGithubContents(octokit, config, path) {
    if (path) {
        return octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: config.githubOwner,
            repo: config.githubRepo,
            path,
            ref: config.githubRef,
        });
    }

    return octokit.request("GET /repos/{owner}/{repo}/contents", {
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: config.githubRef,
    });
}

function mapGithubFetchError(error, resourcePath, timeoutMs) {
    if (error?.name === "AbortError") {
        return new Error(
            `GitHub fetch timed out after ${timeoutMs}ms: ${resourcePath}`,
        );
    }

    const status = getGithubStatus(error);
    if (status === 404) {
        return new Error(`GitHub file not found: ${resourcePath}`);
    }
    if (status === 401 || status === 403) {
        return new Error("GitHub authentication failed");
    }
    if (status) {
        return new Error(`GitHub API failed with status ${status}`);
    }
    return error instanceof Error ? error : new Error(String(error));
}

function getGithubStatus(error) {
    const status = Number(error?.status || error?.response?.status);
    return Number.isFinite(status) ? status : 0;
}

function extractGithubErrorText(error) {
    const data = error?.response?.data;
    if (typeof data === "string") {
        return data;
    }
    if (typeof data?.message === "string" && data.message) {
        return data.message;
    }
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return "";
}

function decodeGithubContent(content, encoding = "base64") {
    if (encoding !== "base64") {
        return String(content || "");
    }
    const normalized = String(content || "").replace(/\n/g, "");
    const bytes = Uint8Array.from(atob(normalized), (char) =>
        char.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
}

function encodeGithubContent(content) {
    const bytes = new TextEncoder().encode(String(content || ""));
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
