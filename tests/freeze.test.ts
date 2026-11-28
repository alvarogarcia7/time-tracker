import test from "node:test";
import assert from "node:assert/strict";

import {
  diffDays,
  formatFrozenLine,
  parseFrozenLine,
  shouldSkipConvert,
  snapshotIsCurrent,
  snapshotName,
} from "../src/core/freeze";

// ---- the frozen line -------------------------------------------------------------------

test("the frozen line is written after the header, in both file kinds", () => {
  const mark = { year: 2026, projects: "2026-11-26T10_21_02" };
  assert.equal(formatFrozenLine(mark), "# frozen: year=2026 projects=2026-11-26T10_21_02");
  assert.equal(formatFrozenLine(mark, true), "<!-- frozen: year=2026 projects=2026-11-26T10_21_02 -->");
});

test("the frozen line is read back in both forms, and other lines are not", () => {
  const mark = { year: 2026, projects: "2026-11-26T10_21_02" };
  assert.deepEqual(parseFrozenLine("# frozen: year=2026 projects=2026-11-26T10_21_02"), mark);
  assert.deepEqual(parseFrozenLine("  <!-- frozen: year=2026 projects=2026-11-26T10_21_02 -->  "), mark);
  assert.equal(parseFrozenLine("# toggl 11/11"), null);
  assert.equal(parseFrozenLine("# frozen: year=26 projects=x"), null);
  assert.equal(parseFrozenLine("# frozen: projects=2026-11-26T10_21_02 year=2026"), null);
  assert.equal(parseFrozenLine("- [ ] 0800 # frozen: year=2026 projects=x"), null);
});

// ---- snapshots -------------------------------------------------------------------------

test("a snapshot is named by its local time, to the second", () => {
  assert.equal(snapshotName(new Date(2026, 10, 26, 10, 21, 2)), "2026-11-26T10_21_02");
  assert.equal(snapshotName(new Date(2026, 0, 5, 9, 3, 4)), "2026-01-05T09_03_04");
});

test("a new snapshot is needed only when projects.yml differs from the newest one", () => {
  assert.equal(snapshotIsCurrent(null, "abc"), false);
  assert.equal(snapshotIsCurrent("abc", "abc"), true);
  assert.equal(snapshotIsCurrent("abc", "def"), false);
});

// ---- the skip test in convert ------------------------------------------------------------

const wanted = { input_sha256: "in1", projects_sha256: "p1", parser_version: "0.3.0", year: 2026 };

test("convert skips a file whose JSON has the same inputs, parser and year", () => {
  assert.equal(shouldSkipConvert(wanted, wanted, false), true);
});

test("convert parses again when there is no JSON, or any input differs", () => {
  assert.equal(shouldSkipConvert(null, wanted, false), false);
  assert.equal(shouldSkipConvert({ ...wanted, input_sha256: "in2" }, wanted, false), false);
  assert.equal(shouldSkipConvert({ ...wanted, projects_sha256: "p2" }, wanted, false), false);
  assert.equal(shouldSkipConvert({ ...wanted, parser_version: "0.2.0" }, wanted, false), false);
  assert.equal(shouldSkipConvert({ ...wanted, year: 2025 }, wanted, false), false);
});

test("FORCE parses every file again", () => {
  assert.equal(shouldSkipConvert(wanted, wanted, true), false);
});

// ---- the reparse diff --------------------------------------------------------------------

const day = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-11-11",
  parsed_at: "2026-11-26T10:00:00+00:00",
  parser_version: "0.3.0",
  entries: [
    { line: 2, start: "08:00", end: "09:00", project: "gym", description: "gym" },
    { line: 3, start: "09:00", end: null, project: "unknown", description: "X" },
  ],
  ...overrides,
});

test("two identical parses have no differences, whatever parsed_at says", () => {
  assert.deepEqual(diffDays(day(), day({ parsed_at: "2027-01-01T00:00:00+00:00" })), []);
});

test("a difference names the entry and the field that changed", () => {
  const changed = day({
    entries: [
      { line: 2, start: "08:00", end: "09:00", project: "gym", description: "gym" },
      { line: 3, start: "09:00", end: null, project: "client-a", description: "X" },
    ],
  });
  assert.deepEqual(diffDays(day(), changed), ['entries[1] (line 3): project "unknown" -> "client-a"']);
});

test("a difference in a top-level field or in the number of entries is reported", () => {
  assert.deepEqual(diffDays(day(), day({ date: "2026-11-12" })), ['date "2026-11-11" -> "2026-11-12"']);
  const shorter = day({ entries: [day().entries[0]] });
  assert.deepEqual(diffDays(day(), shorter), ["entries: 2 -> 1 entries"]);
});
