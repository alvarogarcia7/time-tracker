import test from "node:test";
import assert from "node:assert/strict";

import { CONFIGURATIONS, DEFAULT_PRESET, PERIODS, configurationFor, localDay, movePeriod, periodKey, presetRange } from "../src/core/reports";

test("this week runs Monday to Sunday around today", () => {
  // 2026-11-11 is a Wednesday.
  assert.deepEqual(presetRange("this-week", "2026-11-11"), { start: "2026-11-09", end: "2026-11-15" });
});

test("last week is the Monday to Sunday before", () => {
  assert.deepEqual(presetRange("last-week", "2026-11-11"), { start: "2026-11-02", end: "2026-11-08" });
});

test("weeks on a Monday and a Sunday", () => {
  assert.deepEqual(presetRange("this-week", "2026-11-09"), { start: "2026-11-09", end: "2026-11-15" });
  assert.deepEqual(presetRange("this-week", "2026-11-15"), { start: "2026-11-09", end: "2026-11-15" });
});

test("weeks cross the year end", () => {
  // 2027-01-01 is a Friday.
  assert.deepEqual(presetRange("this-week", "2027-01-01"), { start: "2026-12-28", end: "2027-01-03" });
  assert.deepEqual(presetRange("last-week", "2027-01-01"), { start: "2026-12-21", end: "2026-12-27" });
});

test("this month and last month", () => {
  assert.deepEqual(presetRange("this-month", "2026-11-11"), { start: "2026-11-01", end: "2026-11-30" });
  assert.deepEqual(presetRange("last-month", "2026-11-11"), { start: "2026-10-01", end: "2026-10-31" });
});

test("last month in January is December of the year before", () => {
  assert.deepEqual(presetRange("last-month", "2026-01-05"), { start: "2025-12-01", end: "2025-12-31" });
});

test("this month in a leap February", () => {
  assert.deepEqual(presetRange("this-month", "2028-02-10"), { start: "2028-02-01", end: "2028-02-29" });
  assert.deepEqual(presetRange("last-month", "2028-03-10"), { start: "2028-02-01", end: "2028-02-29" });
});

test("custom has no range of its own", () => {
  assert.equal(presetRange("custom", "2026-11-11"), null);
});

test("the default range is this week", () => {
  assert.equal(DEFAULT_PRESET, "this-week");
});

test("this quarter, last quarter, this half, last half, this year and last year", () => {
  // 2026-11-11 is in Q4 and in the second half of 2026.
  assert.deepEqual(presetRange("this-quarter", "2026-11-11"), { start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("last-quarter", "2026-11-11"), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(presetRange("this-half", "2026-11-11"), { start: "2026-07-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("last-half", "2026-11-11"), { start: "2026-01-01", end: "2026-06-30" });
  assert.deepEqual(presetRange("this-year", "2026-11-11"), { start: "2026-01-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("last-year", "2026-11-11"), { start: "2025-01-01", end: "2025-12-31" });
});

test("quarters and halves at the start of the year look back into the year before", () => {
  // 2026-01-05 is in Q1 and in the first half.
  assert.deepEqual(presetRange("last-quarter", "2026-01-05"), { start: "2025-10-01", end: "2025-12-31" });
  assert.deepEqual(presetRange("last-half", "2026-01-05"), { start: "2025-07-01", end: "2025-12-31" });
  assert.deepEqual(presetRange("this-half", "2026-01-05"), { start: "2026-01-01", end: "2026-06-30" });
  assert.deepEqual(presetRange("last-quarter", "2027-02-10"), { start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("last-half", "2027-02-10"), { start: "2026-07-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("last-year", "2027-02-10"), { start: "2026-01-01", end: "2026-12-31" });
});

test("previous and next move the range by one period of the period control", () => {
  // Weeks run Monday to Sunday.
  assert.deepEqual(movePeriod({ start: "2026-11-09", end: "2026-11-15" }, "weekly", 1), { start: "2026-11-16", end: "2026-11-22" });
  assert.deepEqual(movePeriod({ start: "2026-11-09", end: "2026-11-15" }, "weekly", -1), { start: "2026-11-02", end: "2026-11-08" });
  assert.deepEqual(movePeriod({ start: "2026-11-11", end: "2026-11-11" }, "daily", 1), { start: "2026-11-12", end: "2026-11-12" });
});

test("months move by calendar month and keep the last day of a month at the end", () => {
  assert.deepEqual(movePeriod({ start: "2026-01-01", end: "2026-01-31" }, "monthly", 1), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(movePeriod({ start: "2026-03-01", end: "2026-03-31" }, "monthly", -1), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(movePeriod({ start: "2028-02-01", end: "2028-02-29" }, "monthly", 1), { start: "2028-03-01", end: "2028-03-31" });
  // A range that is not a whole month keeps its days, clamped to the length of the month.
  assert.deepEqual(movePeriod({ start: "2026-11-03", end: "2026-11-05" }, "monthly", 1), { start: "2026-12-03", end: "2026-12-05" });
});

test("quarters and years move by three and twelve months", () => {
  assert.deepEqual(movePeriod({ start: "2026-10-01", end: "2026-12-31" }, "quarterly", 1), { start: "2027-01-01", end: "2027-03-31" });
  assert.deepEqual(movePeriod({ start: "2026-10-01", end: "2026-12-31" }, "quarterly", -1), { start: "2026-07-01", end: "2026-09-30" });
  assert.deepEqual(movePeriod({ start: "2026-01-01", end: "2026-12-31" }, "yearly", 1), { start: "2027-01-01", end: "2027-12-31" });
  assert.deepEqual(movePeriod({ start: "2026-01-01", end: "2026-12-31" }, "yearly", -1), { start: "2025-01-01", end: "2025-12-31" });
});

test("the half period is a calendar half: January to June, or July to December", () => {
  assert.deepEqual(PERIODS, ["daily", "weekly", "monthly", "quarterly", "half", "yearly"]);
  // 2026-11-27 is in the second half; 2026-03-01 is in the first.
  assert.equal(periodKey("2026-11-27", "half"), "2026-H2");
  assert.equal(periodKey("2026-03-01", "half"), "2026-H1");
  assert.equal(periodKey("2026-07-01", "half"), "2026-H2");
  assert.equal(periodKey("2026-06-30", "half"), "2026-H1");
  assert.deepEqual(presetRange("this-half", "2026-11-27"), { start: "2026-07-01", end: "2026-12-31" });
  assert.deepEqual(presetRange("this-half", "2026-03-01"), { start: "2026-01-01", end: "2026-06-30" });
});

test("half moves by six months in both directions", () => {
  assert.deepEqual(movePeriod({ start: "2026-07-01", end: "2026-12-31" }, "half", 1), { start: "2027-01-01", end: "2027-06-30" });
  assert.deepEqual(movePeriod({ start: "2026-07-01", end: "2026-12-31" }, "half", -1), { start: "2026-01-01", end: "2026-06-30" });
  assert.deepEqual(movePeriod({ start: "2026-01-01", end: "2026-06-30" }, "half", -1), { start: "2025-07-01", end: "2025-12-31" });
  assert.deepEqual(movePeriod({ start: "2026-01-01", end: "2026-06-30" }, "half", 1), { start: "2026-07-01", end: "2026-12-31" });
});

test("work this week and work last week set the category and the range", () => {
  assert.deepEqual(CONFIGURATIONS.map((item) => item.name), ["work-this-week", "work-last-week"]);
  assert.deepEqual(configurationFor("work-this-week", "2026-11-11"), {
    preset: "this-week",
    category: "professional",
    start: "2026-11-09",
    end: "2026-11-15",
  });
  assert.deepEqual(configurationFor("work-last-week", "2026-11-11"), {
    preset: "last-week",
    category: "professional",
    start: "2026-11-02",
    end: "2026-11-08",
  });
});

test("localDay formats the local calendar date", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 10, 11)), "2026-11-11");
});
