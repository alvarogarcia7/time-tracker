import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesFilters,
  buildLine,
  classify,
  headerIndex,
  clockTime,
  insertAfter,
  joinLines,
  timeAfter,
  removeLine,
  setLine,
  setTask,
  splitLines,
  withProject,
} from "../src/core/editorModel";
import { loadDatabase } from "../src/core/reports";

const DB = loadDatabase("gym:\n  keywords: [gym, workout]\nlost: [lost]\nshared1: [shared]\nshared2: [other]\n");

test("splitLines and joinLines round-trip, including the final newline", () => {
  const text = "#toggl 11/11\n- [ ] 0800 X\n";

  assert.equal(joinLines(splitLines(text)), text);
  assert.deepEqual(splitLines("a\n"), ["a", ""]);
});

test("classify reads bullet, checkbox, time and description", () => {
  assert.deepEqual(classify("- [ ] 8 X"), { kind: "task", prefix: "- [ ] ", time: "8", description: "X" });
  assert.deepEqual(classify("- [x] -1:10 8"), { kind: "task", prefix: "- [x] ", time: "-1:10", description: "8" });
  assert.deepEqual(classify("* 1100 lunch"), { kind: "task", prefix: "* ", time: "1100", description: "lunch" });
  assert.deepEqual(classify("  - [ ] 0900 indented"), { kind: "task", prefix: "  - [ ] ", time: "0900", description: "indented" });
});

test("classify keeps the time alone when there is no description", () => {
  assert.deepEqual(classify("- [ ] 0800"), { kind: "task", prefix: "- [ ] ", time: "0800", description: "" });
});

test("empty placeholders and other lines are not entries", () => {
  assert.equal(classify("- [ ] ").kind, "other");
  assert.equal(classify("").kind, "other");
  assert.equal(classify("#toggl 11/11").kind, "other");
  assert.equal(classify("<ul>").kind, "other");
});

test("buildLine joins prefix, time and description without stray spaces", () => {
  assert.equal(buildLine("- [ ] ", "0800", "X"), "- [ ] 0800 X");
  assert.equal(buildLine("- [ ] ", "0800", ""), "- [ ] 0800");
  assert.equal(buildLine("- [ ] ", "", "X"), "- [ ] X");
});

test("setTask changes only the time or only the description", () => {
  const lines = ["#toggl 11/11", "- [ ] 0859 watch tv"];

  assert.deepEqual(setTask(lines, 1, { time: "0900" }), ["#toggl 11/11", "- [ ] 0900 watch tv"]);
  assert.deepEqual(setTask(lines, 1, { description: "gym" }), ["#toggl 11/11", "- [ ] 0859 gym"]);
  assert.deepEqual(lines, ["#toggl 11/11", "- [ ] 0859 watch tv"]);
});

test("setTask refuses a line that is not an entry", () => {
  assert.throws(() => setTask(["#toggl 11/11"], 0, { time: "0800" }), /not an entry/);
});

test("insertAfter adds an entry with the same bullet and the given time", () => {
  assert.deepEqual(insertAfter(["#toggl 11/11", "* [x] 0800 a"], 1, "0900"), ["#toggl 11/11", "* [x] 0800 a", "* [x] 0900"]);
  assert.deepEqual(insertAfter(["#toggl 11/11"], 0, ""), ["#toggl 11/11", "- [ ] "]);
});

test("after an entry with an end, the new entry starts there", () => {
  const lines = ["#toggl 11/11", "- [ ] 0800 a", "- [ ] 0900 b"];
  const now = new Date(2026, 10, 11, 14, 5);
  assert.equal(timeAfter(lines, 1, { end: "09:00" }, now), "09:00");
});

test("after the last entry, which is open, the new entry starts at the local time now", () => {
  const lines = ["#toggl 11/11", "- [ ] 0800 a", "- [ ] 0900 b", "- [ ] "];
  const now = new Date(2026, 10, 11, 14, 5);
  assert.equal(timeAfter(lines, 2, { end: null }, now), "14:05");
  assert.equal(clockTime(new Date(2026, 0, 1, 9, 7)), "09:07");
  assert.equal(clockTime(new Date(2026, 0, 1, 23, 59)), "23:59");
});

test("when the file does not parse, the local time is used only if no entry follows", () => {
  const now = new Date(2026, 10, 11, 14, 5);
  assert.equal(timeAfter(["#toggl 11/11", "- [ ] 0900 b"], 1, undefined, now), "14:05");
  assert.equal(timeAfter(["#toggl 11/11", "- [ ] 0900 b", "- [ ] 1000 c"], 1, undefined, now), "");
});

test("removeLine removes an entry but not the header", () => {
  assert.deepEqual(removeLine(["#toggl 11/11", "- [ ] 0800 a", "- [ ] 0900 b"], 1), ["#toggl 11/11", "- [ ] 0900 b"]);
  assert.throws(() => removeLine(["#toggl 11/11"], 0), /not an entry/);
});

test("setLine replaces any line, and headerIndex finds the first non-blank line", () => {
  assert.deepEqual(setLine(["", "a"], 1, "b"), ["", "b"]);
  assert.equal(headerIndex(["", "  ", "#toggl 11/11"]), 2);
  assert.equal(headerIndex([""]), -1);
});

test("withProject adds the project's first keyword when the description does not give it", () => {
  assert.deepEqual(withProject("watch tv", "gym", DB), { description: "watch tv gym" });
  assert.deepEqual(withProject("", "gym", DB), { description: "gym" });
});

test("withProject leaves a description unchanged when it already gives the project", () => {
  assert.deepEqual(withProject("workout", "gym", DB), { description: "workout" });
});

test("withProject reports the clash when the new keyword gives two projects", () => {
  const result = withProject("shared", "shared2", DB);

  assert.equal(result.description, undefined);
  assert.match(result.error ?? "", /shared2/);
  assert.match(result.error ?? "", /shared1/);
});

test("withProject refuses a project without keywords", () => {
  const db = loadDatabase("empty: []\n");

  assert.match(withProject("x", "empty", db).error ?? "", /has no keyword/);
});

test("withProject refuses a project that is not in the database", () => {
  assert.match(withProject("x", "nosuch", DB).error ?? "", /not in the project database/);
});

test("matchesFilters: categorized means the project has a category; no project is uncategorized", () => {
  const all = { category: "all", project: "all" } as const;
  assert.equal(matchesFilters("gym", "personal", all), true);
  assert.equal(matchesFilters("lost", null, all), true);
  assert.equal(matchesFilters("unknown", null, all), true);

  const categorized = { category: "categorized", project: "all" } as const;
  assert.equal(matchesFilters("gym", "personal", categorized), true);
  assert.equal(matchesFilters("lost", null, categorized), false);
  assert.equal(matchesFilters("unknown", null, categorized), false);

  const uncategorized = { category: "uncategorized", project: "all" } as const;
  assert.equal(matchesFilters("gym", "personal", uncategorized), false);
  assert.equal(matchesFilters("lost", null, uncategorized), true);
  assert.equal(matchesFilters("unknown", null, uncategorized), true);
});

test("matchesFilters: with and without a project", () => {
  const withProjectOnly = { category: "all", project: "with" } as const;
  const withoutProject = { category: "all", project: "without" } as const;
  assert.equal(matchesFilters("lost", null, withProjectOnly), true);
  assert.equal(matchesFilters("unknown", null, withProjectOnly), false);
  assert.equal(matchesFilters("unknown", null, withoutProject), true);
  assert.equal(matchesFilters("gym", "personal", withoutProject), false);
});

test("matchesFilters combines both filters", () => {
  const both = { category: "categorized", project: "with" } as const;
  assert.equal(matchesFilters("gym", "personal", both), true);
  assert.equal(matchesFilters("lost", null, both), false);
  assert.equal(matchesFilters("unknown", null, both), false);
});

test("withProject replaces the keyword of a keyword split instead of adding one", () => {
  assert.deepEqual(withProject("lost: wash", "gym", DB), { description: "gym: wash" });
  assert.deepEqual(withProject("wash, lost", "gym", DB), { description: "wash, gym" });
});
