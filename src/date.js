export function getCurrentDateInfo(timezone, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const weekday = new Intl.DateTimeFormat("zh-TW", {
        timeZone: timezone,
        weekday: "long",
    }).format(now);

    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    return {
        year,
        month,
        day,
        isoDate: `${year}-${pad2(month)}-${pad2(day)}`,
        displayDate: `${year}/${pad2(month)}/${pad2(day)}`,
        weekday,
        timezone,
    };
}

export function buildDateInfoFromIsoDate(isoDate, timezone) {
    const [year, month, day] = isoDate.split("-").map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    const weekday = new Intl.DateTimeFormat("zh-TW", {
        timeZone: timezone,
        weekday: "long",
    }).format(utcDate);

    return {
        year,
        month,
        day,
        isoDate,
        displayDate: `${year}/${pad2(month)}/${pad2(day)}`,
        weekday,
        timezone,
    };
}

export function detectReadingLookupDateFromText(userText, currentDateInfo) {
    const text = String(userText || "").trim();
    if (!text || !looksLikeReadingLookupText(text)) {
        return null;
    }

    const explicitDate =
        tryParseIsoLikeDate(text) ||
        tryParseMonthDayDate(text, currentDateInfo);
    if (explicitDate) {
        return explicitDate;
    }
    if (/前天/.test(text)) {
        return shiftDateByDays(currentDateInfo, -2).isoDate;
    }
    if (/昨天|昨日/.test(text)) {
        return shiftDateByDays(currentDateInfo, -1).isoDate;
    }
    if (/今天|今日/.test(text)) {
        return currentDateInfo.isoDate;
    }
    return null;
}

export function pad2(value) {
    return String(value).padStart(2, "0");
}

function buildDateInfoFromDate(date, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    return buildDateInfoFromIsoDate(
        `${year}-${pad2(month)}-${pad2(day)}`,
        timezone,
    );
}

function looksLikeReadingLookupText(text) {
    return /(讀了什麼|看了什麼|閱讀紀錄|讀過什麼|what did i read)/i.test(text);
}

function tryParseIsoLikeDate(text) {
    const match = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
    if (!match) {
        return null;
    }
    return buildIsoDateIfValid(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
    );
}

function tryParseMonthDayDate(text, currentDateInfo) {
    const match = text.match(/\b(\d{1,2})[/-](\d{1,2})\b/);
    if (!match) {
        return null;
    }
    return buildIsoDateIfValid(
        currentDateInfo.year,
        Number(match[1]),
        Number(match[2]),
    );
}

function buildIsoDateIfValid(year, month, day) {
    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        !Number.isInteger(day)
    ) {
        return null;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() + 1 !== month ||
        date.getUTCDate() !== day
    ) {
        return null;
    }
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function shiftDateByDays(currentDateInfo, days) {
    const date = new Date(
        Date.UTC(
            currentDateInfo.year,
            currentDateInfo.month - 1,
            currentDateInfo.day,
        ),
    );
    date.setUTCDate(date.getUTCDate() + days);
    return buildDateInfoFromDate(date, currentDateInfo.timezone);
}
