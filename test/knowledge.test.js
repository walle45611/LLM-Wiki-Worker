import test from "node:test";
import assert from "node:assert/strict";

import {
    extractLogForDate,
    extractSummaryReferencesFromLog,
    normalizeWikiPath,
    parseSummaryIndex,
    parseSummaryIndexEntries,
    resolveSummaryPathsForDate,
} from "../src/knowledge.js";

test("extractLogForDate returns dated section until next heading", () => {
    const logContent = `
# 2026-04-19
- Read chapter 1
- Read chapter 2

# 2026-04-18
- Old content
`.trim();

    const result = extractLogForDate(logContent, {
        year: 2026,
        month: 4,
        day: 19,
    });

    assert.equal(result, "# 2026-04-19\n- Read chapter 1\n- Read chapter 2");
});

test("extractLogForDate falls back to paragraphs when no heading sections exist", () => {
    const logContent = `
2026/04/19 閱讀了 Cloudflare Workers 文件，重點是 AI binding。

2026/04/18 舊紀錄。
`.trim();

    const result = extractLogForDate(logContent, {
        year: 2026,
        month: 4,
        day: 19,
    });

    assert.match(result, /Cloudflare Workers/);
    assert.doesNotMatch(result, /舊紀錄/);
});

test("extractSummaryReferencesFromLog reads created and updated references", () => {
    const logContent = `
## [2026-04-18] ingest | title

- created: \`wiki/summaries/alpha.md\`, \`wiki/concepts/x.md\`
- updated: \`wiki/index.md\`, \`how-to-learn-anything-faster-using-modern-research\`

## [2026-04-17] ingest | old
- created: \`wiki/summaries/old.md\`
`.trim();

    const references = extractSummaryReferencesFromLog(logContent, {
        year: 2026,
        month: 4,
        day: 18,
    });

    assert.deepEqual(references, [
        "wiki/summaries/alpha.md",
        "wiki/concepts/x.md",
        "wiki/index.md",
        "how-to-learn-anything-faster-using-modern-research",
    ]);
});

test("parseSummaryIndex maps summary slug to wiki path", () => {
    const indexContent = `
# Wiki Index

## Summaries
- [alpha](/Users/demo/wiki/summaries/alpha.md): A

## Concepts
- [effective-learning](/Users/demo/wiki/concepts/effective-learning.md): B
`.trim();

    const mapping = parseSummaryIndex(indexContent);
    assert.equal(mapping.get("alpha"), "wiki/summaries/alpha.md");
    assert.equal(mapping.has("effective-learning"), false);
});

test("parseSummaryIndexEntries extracts slug path and description", () => {
    const indexContent = `
## Summaries
- [alpha](wiki/summaries/alpha.md): alpha desc
- [beta](wiki/summaries/beta.md): beta desc
`.trim();

    const entries = parseSummaryIndexEntries(indexContent);
    assert.deepEqual(entries, [
        {
            slug: "alpha",
            path: "wiki/summaries/alpha.md",
            description: "alpha desc",
        },
        {
            slug: "beta",
            path: "wiki/summaries/beta.md",
            description: "beta desc",
        },
    ]);
});

test("resolveSummaryPathsForDate keeps summaries and resolves slug via index", () => {
    const logContent = `
## [2026-04-18] ingest | title
- created: \`wiki/summaries/alpha.md\`, \`wiki/concepts/effective-learning.md\`
- updated: \`how-to-learn-anything-faster-using-modern-research\`, \`unknown-slug\`
`.trim();
    const indexContent = `
## Summaries
- [how-to-learn-anything-faster-using-modern-research](/Users/demo/wiki/summaries/how-to-learn-anything-faster-using-modern-research.md): A
`.trim();

    const resolved = resolveSummaryPathsForDate(logContent, indexContent, {
        year: 2026,
        month: 4,
        day: 18,
    });

    assert.deepEqual(resolved.summaryPaths.sort(), [
        "wiki/summaries/alpha.md",
        "wiki/summaries/how-to-learn-anything-faster-using-modern-research.md",
    ]);
    assert.deepEqual(resolved.unresolvedReferences, [
        "wiki/concepts/effective-learning.md",
        "unknown-slug",
    ]);
});

test("normalizeWikiPath converts absolute wiki paths", () => {
    assert.equal(
        normalizeWikiPath("/Users/name/vault/wiki/summaries/a.md"),
        "wiki/summaries/a.md",
    );
});

test("normalizeWikiPath converts relative summaries/concepts paths", () => {
    assert.equal(
        normalizeWikiPath(
            "./summaries/harness-engineering-language-models-need-human-guidance.md",
        ),
        "wiki/summaries/harness-engineering-language-models-need-human-guidance.md",
    );
    assert.equal(
        normalizeWikiPath("./concepts/harness-engineering.md"),
        "wiki/concepts/harness-engineering.md",
    );
});
