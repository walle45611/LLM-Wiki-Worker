const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 15000;
const GITHUB_TREE_TOTAL_TIMEOUT_MS = 12000;
const GITHUB_TREE_MAX_ENTRIES = 400;

export async function fetchGithubFile(config, filePath, options = {}) {
    const { logInfo, timeoutMs } = options;
    const encodedPath = filePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(config.githubRef)}`;
    logInfo?.("github.fetch_started", {
        owner: config.githubOwner,
        repo: config.githubRepo,
        ref: config.githubRef,
        path: filePath,
    });

    const startedAt = Date.now();
    let response = null;
    try {
        response = await fetchWithTimeout(
            url,
            config.githubToken,
            filePath,
            timeoutMs,
        );
    } catch (error) {
        logInfo?.("github.fetch_failed", {
            path: filePath,
            elapsedMs: Date.now() - startedAt,
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
    logInfo?.("github.fetch_response", {
        path: filePath,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
    });

    if (response.status === 404) {
        throw new Error(`GitHub file not found: ${filePath}`);
    }
    if (response.status === 401 || response.status === 403) {
        throw new Error("GitHub authentication failed");
    }
    if (!response.ok) {
        throw new Error(`GitHub API failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.content) {
        throw new Error("GitHub API returned empty file content");
    }

    const normalized = payload.content.replace(/\n/g, "");
    const bytes = Uint8Array.from(atob(normalized), (char) =>
        char.charCodeAt(0),
    );
    const decoded = new TextDecoder().decode(bytes);
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
    const encodedPath = filePath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}`;
    const message =
        String(commitMessage || "").trim() || `chore: update ${filePath}`;

    let sha = null;
    try {
        const existingResponse = await fetchWithTimeout(
            `${url}?ref=${encodeURIComponent(config.githubRef)}`,
            config.githubToken,
            filePath,
            GITHUB_FETCH_TIMEOUT_MS,
        );
        if (existingResponse.ok) {
            const payload = await existingResponse.json();
            sha = typeof payload?.sha === "string" ? payload.sha : null;
        }
    } catch (error) {
        logInfo?.("github.upsert_lookup_failed", {
            path: filePath,
            errorMessage:
                error instanceof Error ? error.message : String(error),
        });
    }

    const body = {
        message,
        content: btoa(unescape(encodeURIComponent(String(content || "")))),
        branch: config.githubRef,
    };
    if (sha) {
        body.sha = sha;
    }

    logInfo?.("github.upsert_started", {
        path: filePath,
        hasExistingSha: Boolean(sha),
        message,
    });
    const response = await fetchWithTimeout(
        url,
        config.githubToken,
        filePath,
        GITHUB_FETCH_TIMEOUT_MS,
        {
            method: "PUT",
            body: JSON.stringify(body),
        },
    );
    if (!response.ok) {
        const text = await safeReadResponseText(response);
        throw new Error(
            `GitHub upsert failed with status ${response.status}: ${text}`,
        );
    }
    const payload = await response.json();
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
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const contentsPath = encodedPath ? `/${encodedPath}` : "";
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents${contentsPath}?ref=${encodeURIComponent(config.githubRef)}`;
    const response = await fetchWithTimeout(
        url,
        config.githubToken,
        path,
        GITHUB_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
        throw new Error(`GitHub API failed with status ${response.status}`);
    }

    const payload = await response.json();
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

async function fetchWithTimeout(
    url,
    githubToken,
    resourcePath,
    timeoutMs = GITHUB_FETCH_TIMEOUT_MS,
    init = {},
) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${githubToken}`,
                "User-Agent": "llmwikiworker",
                "X-GitHub-Api-Version": "2022-11-28",
                ...(init.headers || {}),
            },
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error(
                `GitHub fetch timed out after ${timeoutMs}ms: ${resourcePath}`,
            );
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function safeReadResponseText(response) {
    try {
        return await response.text();
    } catch {
        return "";
    }
}
