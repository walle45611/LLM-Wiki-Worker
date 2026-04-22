import { buildDateVariants, normalizeWikiPath } from "../knowledge.js";

export function getCompletionRejectionReason({
    reply,
    singleDateReviewInfo,
    successfulFileReads,
    toolFailures,
}) {
    if (!String(reply || "").trim()) {
        return "你剛才的最終回覆是空的。請重新產出完整回覆。";
    }

    const reviewIssue = getSingleDateReviewIssue(
        reply,
        singleDateReviewInfo,
        successfulFileReads,
    );
    if (reviewIssue) {
        return reviewIssue;
    }

    if (toolFailures.length === 0) {
        return "";
    }

    const latestFailure = toolFailures.at(-1);
    return `本輪 review 任務曾發生 tool 失敗（${latestFailure?.name || "unknown"}），不得帶著殘缺上下文直接結束。請補齊必要讀檔後再回答。`;
}

export function rememberSuccessfulFileRead(successfulFileReads, toolResult) {
    if (
        typeof toolResult?.path !== "string" ||
        typeof toolResult?.content !== "string" ||
        toolResult.error
    ) {
        return;
    }

    successfulFileReads.set(
        normalizeWikiPath(toolResult.path),
        toolResult.content,
    );
}

function getSingleDateReviewIssue(
    reply,
    singleDateReviewInfo,
    successfulFileReads,
) {
    if (!singleDateReviewInfo) {
        return "";
    }

    const indexPath = "wiki/index.md";
    if (!successfulFileReads.has(indexPath)) {
        return `你正在處理單日閱讀回顧，但尚未讀取必要檔案 \`${indexPath}\`。請先依 review-rules 讀取 index，再決定要讀哪些 summary。`;
    }

    const expectedSummaryPaths = extractSummaryPathsForDateFromIndex(
        successfulFileReads.get(indexPath) || "",
        singleDateReviewInfo,
    );
    const missingSummaryPaths = expectedSummaryPaths.filter(
        (path) => !successfulFileReads.has(path),
    );
    if (missingSummaryPaths.length > 0) {
        return `你正在處理單日閱讀回顧 ${singleDateReviewInfo.isoDate}，但尚未讀完這一天命中的 summary：${missingSummaryPaths.join(", ")}。請先逐篇讀完，再重新整理回覆。`;
    }

    if (expectedSummaryPaths.length > 0) {
        return "";
    }

    const noDataReply = "您在這一天沒有新增任何閱讀紀錄喔！";
    if (reply.trim() === noDataReply) {
        return "";
    }

    return `你正在處理單日閱讀回顧 ${singleDateReviewInfo.isoDate}，而 \`wiki/index.md\` 沒有命中任何 summary。依 review-rules，這種情況只能回覆：${noDataReply}`;
}

function extractSummaryPathsForDateFromIndex(indexContent, dateInfo) {
    const variants = buildDateVariants(dateInfo);
    const lines = String(indexContent || "").split(/\r?\n/);
    const paths = [];
    let inSummaries = false;

    for (const entry of lines) {
        if (/^\s*##\s+Summaries\s*$/i.test(entry)) {
            inSummaries = true;
            continue;
        }
        if (
            /^\s*##\s+/.test(entry) &&
            !/^\s*##\s+Summaries\s*$/i.test(entry)
        ) {
            inSummaries = false;
            continue;
        }
        if (
            !inSummaries ||
            !variants.some((variant) => entry.includes(variant))
        ) {
            continue;
        }
        const linkMatch = entry.match(/\[[^\]]+\]\(([^)]+)\)/);
        if (linkMatch) {
            paths.push(normalizeWikiPath(linkMatch[1]));
        }
    }

    return Array.from(new Set(paths));
}
