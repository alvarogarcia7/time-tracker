import test from "node:test";
import assert from "node:assert/strict";

import { addEntry, clockOfToken, durationLabel, frequentProjects, isPlaceholder, isReferenceLine, matchingProjects, normalizeStart } from "../src/core/mobileEditor";

test("a new entry fills the placeholder line of a new day", () => {
  const added = addEntry(["27/11/2026", "# Date, description, project:b:c", "- [ ] ", ""], "0800", "wake up");

  assert.deepEqual(added.lines, ["27/11/2026", "# Date, description, project:b:c", "- [ ] 0800 wake up", ""]);
  assert.equal(added.index, 2);
});

test("a new entry goes after the last entry, before trailing blank lines", () => {
  const added = addEntry(["27/11/2026", "- [ ] 0800 a", "", ""], "0900", "b");

  assert.deepEqual(added.lines, ["27/11/2026", "- [ ] 0800 a", "- [ ] 0900 b", "", ""]);
  assert.equal(added.index, 2);
});

test("a new entry after a given line takes its prefix", () => {
  const added = addEntry(["27/11/2026", "* 0800 a", "* 1000 c"], "0900", "b", 1);

  assert.deepEqual(added.lines, ["27/11/2026", "* 0800 a", "* 0900 b", "* 1000 c"]);
  assert.equal(added.index, 2);
});

test("an entry can be added to a file with only a header", () => {
  assert.deepEqual(addEntry(["27/11/2026"], "0800", "").lines, ["27/11/2026", "- [ ] 0800"]);
});

test("placeholders are empty entry lines", () => {
  assert.equal(isPlaceholder("- [ ] "), true);
  assert.equal(isPlaceholder("- [ ] 0800"), false);
});

test("a time input shows the time of a token", () => {
  assert.equal(clockOfToken("0806"), "08:06");
  assert.equal(clockOfToken("806"), "08:06");
  assert.equal(clockOfToken("-20"), "");
  assert.equal(clockOfToken("2599"), "");
});

test("durations are short", () => {
  assert.equal(durationLabel(25), "25m");
  assert.equal(durationLabel(60), "1h");
  assert.equal(durationLabel(85), "1h 25m");
  assert.equal(durationLabel(null), null);
});

test("frequent projects are by time, without unknown", () => {
  const entries = [
    { project: "gym", duration_minutes: 30 },
    { project: "work", duration_minutes: 120 },
    { project: "unknown", duration_minutes: 500 },
    { project: "gym", duration_minutes: 40 },
  ];

  assert.deepEqual(frequentProjects(entries, "unknown", 5), ["work", "gym"]);
  assert.deepEqual(frequentProjects(entries, "unknown", 1), ["work"]);
});

test("typed words find projects, names that start with the text first", () => {
  const names = ["tii:platform", "perso:chores", "chores", "perso:shave"];

  assert.deepEqual(matchingProjects(names, "chores", 5), ["chores", "perso:chores"]);
  assert.deepEqual(matchingProjects(names, "perso sh", 5), ["perso:shave"]);
  assert.deepEqual(matchingProjects(names, "zzz", 5), []);
  assert.deepEqual(matchingProjects(names, "perso:s", 5), ["perso:shave"]);
});

test("a reference line is one whose description is not what the parser gave the entry", () => {
  assert.equal(isReferenceLine("806", "Tii:time-entries"), true);
  assert.equal(isReferenceLine("wash dishes", "wash dishes"), false);
  assert.equal(isReferenceLine("", ""), false);
});

test("a typed start time is read in the forms people write", () => {
  assert.equal(normalizeStart("7.15"), "07:15");
  assert.equal(normalizeStart("07:15"), "07:15");
  assert.equal(normalizeStart("830"), "08:30");
  assert.equal(normalizeStart(" 8:30 "), "08:30");
  assert.equal(normalizeStart("+10"), "+10");
  assert.equal(normalizeStart("-1:10"), "-1:10");
  assert.equal(normalizeStart("quarter past nine"), null);
  assert.equal(normalizeStart("25:00"), null);
  assert.equal(normalizeStart("6am"), null);
  assert.equal(normalizeStart(""), null);
});
