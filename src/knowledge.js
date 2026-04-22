export function buildDateVariants(dateInfo) {
    return [
        `${dateInfo.year}-${pad2(dateInfo.month)}-${pad2(dateInfo.day)}`,
        `${dateInfo.year}-${dateInfo.month}-${dateInfo.day}`,
        `${dateInfo.year}/${pad2(dateInfo.month)}/${pad2(dateInfo.day)}`,
        `${dateInfo.year}/${dateInfo.month}/${dateInfo.day}`,
        `${dateInfo.year}.${pad2(dateInfo.month)}.${pad2(dateInfo.day)}`,
        `${dateInfo.year}.${dateInfo.month}.${dateInfo.day}`,
        `${dateInfo.year}年${dateInfo.month}月${dateInfo.day}日`,
        `${dateInfo.year}年${pad2(dateInfo.month)}月${pad2(dateInfo.day)}日`,
    ];
}

export function textContainsAnyVariant(text, variants) {
    return variants.some((variant) => text.includes(variant));
}

export function extractParagraphMatches(logContent, variants) {
    const sections = logContent.split(/\n{2,}/);
    const matches = sections.filter((section) =>
        textContainsAnyVariant(section, variants),
    );
    return matches.join("\n\n").trim();
}

export function extractLogForDate(logContent, dateInfo) {
    const variants = buildDateVariants(dateInfo);
    const lines = logContent.split(/\r?\n/);
    const blocks = [];
    const seen = new Set();
    const genericDateLine =
        /^(\s{0,3}#{1,6}\s*)?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)/;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!textContainsAnyVariant(line, variants)) {
            continue;
        }

        const blockLines = [line];
        let blankCount = 0;

        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const nextLine = lines[cursor];
            const trimmed = nextLine.trim();

            if (
                genericDateLine.test(trimmed) &&
                !textContainsAnyVariant(nextLine, variants)
            ) {
                break;
            }

            if (
                /^\s*#{1,6}\s+/.test(trimmed) &&
                !textContainsAnyVariant(nextLine, variants)
            ) {
                break;
            }

            blockLines.push(nextLine);

            if (trimmed === "") {
                blankCount += 1;
                if (blankCount >= 2) {
                    break;
                }
            } else {
                blankCount = 0;
            }
        }

        const block = blockLines.join("\n").trim();
        if (block && !seen.has(block)) {
            blocks.push(block);
            seen.add(block);
        }
    }

    if (blocks.length > 0) {
        return blocks.join("\n\n");
    }

    return extractParagraphMatches(logContent, variants);
}

export function extractLogBlocksForDate(logContent, dateInfo) {
    const variants = buildDateVariants(dateInfo);
    const lines = logContent.split(/\r?\n/);
    const blocks = [];
    let currentHeader = null;
    let currentLines = [];

    for (const line of lines) {
        if (/^\s*##\s+/.test(line)) {
            if (
                currentHeader &&
                textContainsAnyVariant(currentHeader, variants)
            ) {
                blocks.push([currentHeader, ...currentLines].join("\n").trim());
            }
            currentHeader = line;
            currentLines = [];
            continue;
        }

        if (currentHeader) {
            currentLines.push(line);
        }
    }

    if (currentHeader && textContainsAnyVariant(currentHeader, variants)) {
        blocks.push([currentHeader, ...currentLines].join("\n").trim());
    }

    return blocks.filter(Boolean);
}

export function parsePathList(value) {
    const inlineCodeMatches = [...value.matchAll(/`([^`]+)`/g)].map(
        (match) => match[1],
    );
    if (inlineCodeMatches.length > 0) {
        return inlineCodeMatches;
    }

    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function extractSummaryReferencesFromLog(logContent, dateInfo) {
    const blocks = extractLogBlocksForDate(logContent, dateInfo);
    const references = [];

    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/^\s*-\s*(created|updated)\s*:\s*(.+)$/i);
            if (!match) {
                continue;
            }
            references.push(...parsePathList(match[2]));
        }
    }

    return references;
}

export function normalizeWikiPath(rawPath) {
    const cleaned = rawPath.trim().replace(/^['"`]|['"`]$/g, "");
    let slashNormalized = cleaned.replace(/\\/g, "/");
    const wikiIndex = slashNormalized.indexOf("wiki/");
    if (wikiIndex >= 0) {
        return slashNormalized.slice(wikiIndex);
    }

    if (slashNormalized.startsWith("./")) {
        slashNormalized = slashNormalized.slice(2);
    }

    if (slashNormalized.startsWith("/")) {
        slashNormalized = slashNormalized.slice(1);
    }

    if (
        slashNormalized.startsWith("summaries/") ||
        slashNormalized.startsWith("concepts/") ||
        slashNormalized.startsWith("rules/")
    ) {
        return `wiki/${slashNormalized}`;
    }

    return slashNormalized;
}

export function parseSummaryIndexEntries(indexContent) {
    const lines = indexContent.split(/\r?\n/);
    let inSummariesSection = false;
    const entries = [];

    for (const line of lines) {
        if (/^\s*##\s+Summaries\s*$/i.test(line)) {
            inSummariesSection = true;
            continue;
        }

        if (/^\s*##\s+/.test(line) && !/^\s*##\s+Summaries\s*$/i.test(line)) {
            inSummariesSection = false;
            continue;
        }

        if (!inSummariesSection) {
            continue;
        }

        const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
        if (!linkMatch) {
            continue;
        }

        const slug = linkMatch[1].trim().toLowerCase();
        const path = normalizeWikiPath(linkMatch[2]);
        if (path.includes("wiki/summaries/") && path.endsWith(".md")) {
            const description = line.includes(":")
                ? line.slice(line.indexOf(":") + 1).trim()
                : "";
            entries.push({ slug, path, description });
        }
    }

    return entries;
}

export function parseSummaryIndex(indexContent) {
    const entries = parseSummaryIndexEntries(indexContent);
    const mapping = new Map();
    for (const entry of entries) {
        mapping.set(entry.slug, entry.path);
    }
    return mapping;
}

export function resolveSummaryPathsForDate(logContent, indexContent, dateInfo) {
    const references = extractSummaryReferencesFromLog(logContent, dateInfo);
    const indexMap = parseSummaryIndex(indexContent);
    const summaryPaths = new Set();
    const unresolvedReferences = [];

    for (const reference of references) {
        const normalized = normalizeWikiPath(reference);
        const lowered = normalized.toLowerCase();

        if (lowered.startsWith("wiki/summaries/") && lowered.endsWith(".md")) {
            summaryPaths.add(normalized);
            continue;
        }

        const slug = lowered.replace(/\.md$/, "").split("/").pop();
        const fromIndex = slug ? indexMap.get(slug) : null;
        if (fromIndex) {
            summaryPaths.add(fromIndex);
            continue;
        }

        unresolvedReferences.push(reference);
    }

    return {
        summaryPaths: Array.from(summaryPaths),
        unresolvedReferences,
    };
}

export async function fetchSummaryFiles(paths, fetchFile) {
    const files = [];
    const missingPaths = [];

    await Promise.all(
        paths.map(async (path) => {
            try {
                const content = await fetchFile(path);
                files.push({ path, content });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                if (message.includes("GitHub file not found")) {
                    missingPaths.push(path);
                    return;
                }
                throw error;
            }
        }),
    );

    return { files, missingPaths };
}

function pad2(value) {
    return String(value).padStart(2, "0");
}
