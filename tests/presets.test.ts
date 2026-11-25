import test from "node:test";
import assert from "node:assert/strict";

import { localDay, presetRange } from "../src/core/reports";

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

test("localDay formats the local calendar date", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
  assert.equal(localDay(new Date(2026, 10, 11)), "2026-11-11");
});
