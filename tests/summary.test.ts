import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  OPEN_ENTRY_MINUTES,
  PALETTE,
  UNKNOWN_COLOR,
  axisFor,
  formatMinutes,
  groupByProject,
  hourTicks,
  projectColors,
  segmentsFor,
  toMinutes,
  totals,
  validate,
} from "../src/core/summary";

const expected = (name: string) =>
  validate(JSON.parse(readFileSync(join(__dirname, "../tests/fixtures/sample/expected", `${name}.json`), "utf-8")));

test("validate accepts parser output and rejects other JSON", () => {
  assert.equal(validate(expected("day")).entries.length, 4);
  assert.throws(() => validate({ date: "2026-11-11" }), /"entries" array/);
  assert.throws(() => validate(null), /JSON object/);
  assert.throws(() => validate({ entries: [{ description: "no start" }] }), /Entry 1 has no start time/);
});

test("toMinutes and formatMinutes", () => {
  assert.equal(toMinutes("08:30"), 510);
  assert.throws(() => toMinutes("8:30"));
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(90), "1h 30m");
  assert.equal(formatMinutes(null), "open");
});

test("totals sum durations and count open entries", () => {
  assert.deepEqual(totals(expected("day").entries), { minutes: 186, open: 1, count: 4 });
});

test("groupByProject orders by tracked time with unknown last", () => {
  const groups = groupByProject(expected("week-day").entries);

  assert.deepEqual(
    groups.map((g) => [g.project, g.minutes, g.open, g.count]),
    [
      ["gym", 90, 0, 2],
      ["client-a", 60, 0, 2],
      ["deep-work", 60, 0, 2],
      ["unknown", 0, 1, 1],
    ],
  );
});

test("projectColors gives each project a palette colour and unknown grey", () => {
  const colors = projectColors(expected("week-day").entries);

  assert.equal(colors.get("client-a"), PALETTE[0]);
  assert.equal(colors.get("deep-work"), PALETTE[1]);
  assert.equal(colors.get("gym"), PALETTE[2]);
  assert.equal(colors.get("unknown"), UNKNOWN_COLOR);
});

test("projectColors is the same for the same projects in any order", () => {
  const entries = expected("week-day").entries;
  const reversed = [...entries].reverse();

  assert.deepEqual([...projectColors(entries)], [...projectColors(reversed)]);
});

test("projectColors cycles the palette when there are more projects than colours", () => {
  const entries = Array.from({ length: PALETTE.length + 1 }, (_, i) => ({
    ...expected("day").entries[0],
    project: `p${String(i).padStart(2, "0")}`,
  }));
  const colors = projectColors(entries);

  assert.equal(colors.get("p00"), PALETTE[0]);
  assert.equal(colors.get(`p${PALETTE.length}`), PALETTE[0]);
});

test("axisFor covers whole hours around the entries", () => {
  // day.json starts at 08:00. Its last entry is open at 11:06 and counts as an hour, so the axis ends at 13:00.
  const axis = axisFor(expected("day").entries);

  assert.deepEqual(axis, { startMinute: 8 * 60, endMinute: 13 * 60 });
});

test("axisFor gives an open final entry a fixed visible length", () => {
  const entries = [{ ...expected("week-day").entries[6] }];
  const axis = axisFor(entries);

  assert.equal(axis.startMinute, 11 * 60);
  assert.equal(axis.endMinute, 12 * 60);
  assert.equal(toMinutes(entries[0].start) + OPEN_ENTRY_MINUTES, 12 * 60);
});

test("axisFor falls back to a working day when there are no entries", () => {
  assert.deepEqual(axisFor([]), { startMinute: 8 * 60, endMinute: 18 * 60 });
});

test("segmentsFor places each entry as a percentage of the axis", () => {
  const entries = expected("week-day").entries;
  const axis = axisFor(entries);
  const segments = segmentsFor(entries, axis);

  // Axis is 07:00 to 12:00, five hours, so 300 minutes.
  assert.equal(axis.startMinute, 7 * 60);
  assert.equal(axis.endMinute, 12 * 60);
  assert.equal(segments[0].left, 10);
  assert.equal(segments[0].width, 20);
  assert.equal(segments[6].open, true);
});

test("hourTicks label each hour, or every two hours for a long day", () => {
  const short = hourTicks({ startMinute: 8 * 60, endMinute: 12 * 60 });
  assert.deepEqual(short.map((t) => t.label), ["08:00", "09:00", "10:00", "11:00", "12:00"]);
  assert.equal(short[0].left, 0);
  assert.equal(short[short.length - 1].left, 100);

  const long = hourTicks({ startMinute: 0, endMinute: 24 * 60 });
  assert.deepEqual(long.map((t) => t.label), ["00:00", "02:00", "04:00", "06:00", "08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00", "00:00"]);
});
