import test from "node:test";
import assert from "node:assert/strict";

import {
    buildDateInfoFromIsoDate,
    detectReadingLookupDateFromText,
    getCurrentDateInfo,
} from "../src/date.js";
import { buildDateVariants } from "../src/knowledge.js";
import { createCurrentDateInfo } from "../testing/helpers.js";

test("buildDateVariants includes common date formats", () => {
    const variants = buildDateVariants({ year: 2026, month: 4, day: 19 });

    assert.ok(variants.includes("2026-04-19"));
    assert.ok(variants.includes("2026/4/19"));
    assert.ok(variants.includes("2026年4月19日"));
});

test("buildDateInfoFromIsoDate expands iso date into display fields", () => {
    const info = buildDateInfoFromIsoDate("2026-04-18", "Asia/Taipei");

    assert.equal(info.displayDate, "2026/04/18");
    assert.equal(info.weekday, "星期六");
    assert.equal(info.timezone, "Asia/Taipei");
});

test("getCurrentDateInfo returns timezone based date parts", () => {
    const info = getCurrentDateInfo(
        "Asia/Taipei",
        new Date("2026-04-19T03:00:00Z"),
    );

    assert.match(info.isoDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(info.timezone, "Asia/Taipei");
    assert.equal(info.displayDate, "2026/04/19");
    assert.equal(info.weekday, "星期日");
});

test("detectReadingLookupDateFromText parses explicit date for reading query", () => {
    const isoDate = detectReadingLookupDateFromText(
        "2026/4/18 我讀了什麼",
        createCurrentDateInfo(),
    );

    assert.equal(isoDate, "2026-04-18");
});

test("detectReadingLookupDateFromText parses relative date for reading query", () => {
    const isoDate = detectReadingLookupDateFromText(
        "昨天我讀了什麼",
        createCurrentDateInfo(),
    );

    assert.equal(isoDate, "2026-04-18");
});
