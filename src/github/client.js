const GITHUB_API_BASE = "https://api.github.com";

export async function fetchGithubFile(config, filePath, options = {}) {
    const { logInfo } = options;
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
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${config.githubToken}`,
            "User-Agent": "llmwikiworker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
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

export async function fetchGithubFileTree(config, basePath, maxDepth) {
    const entries = [];
    await walkGithubDir(
        config,
        normalizePath(basePath),
        0,
        Math.max(1, Math.min(Number(maxDepth || 2), 4)),
        entries,
    );
    return entries;
}

async function walkGithubDir(config, path, depth, maxDepth, output) {
    const encodedPath = path
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(config.githubOwner)}/${encodeURIComponent(config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(config.githubRef)}`;
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${config.githubToken}`,
            "User-Agent": "llmwikiworker",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub API failed with status ${response.status}`);
    }

    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : [];
    for (const item of items) {
        output.push({ path: item.path, type: item.type });
        if (item.type === "dir" && depth + 1 < maxDepth) {
            await walkGithubDir(config, item.path, depth + 1, maxDepth, output);
        }
    }
}

function normalizePath(path) {
    return String(path || "")
        .replace(/^\/+/, "")
        .trim();
}
