const MAX_LOG_PREVIEW_LENGTH = 280;

export function toPreview(text) {
    if (!text) {
        return "";
    }
    const normalized = String(text).replace(/\s+/g, " ").trim();
    if (normalized.length <= MAX_LOG_PREVIEW_LENGTH) {
        return normalized;
    }
    return `${normalized.slice(0, MAX_LOG_PREVIEW_LENGTH)}...`;
}

export function toJsonPreview(value) {
    try {
        return toPreview(JSON.stringify(value));
    } catch {
        return toPreview(String(value));
    }
}

export function logInfo(event, fields = {}) {
    console.log({ level: "info", event, ...fields });
}

export function logWarn(event, fields = {}) {
    console.warn({ level: "warn", event, ...fields });
}

export function logError(event, fields = {}, error) {
    const normalizedError =
        error instanceof Error
            ? {
                  name: error.name,
                  message: error.message,
                  stack: toPreview(error.stack || ""),
              }
            : { message: toPreview(String(error)) };
    console.error({ level: "error", event, ...fields, error: normalizedError });
}
