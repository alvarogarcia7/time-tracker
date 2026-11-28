import test from "node:test";
import assert from "node:assert/strict";

import { parseDay } from "../src/core/parser";
import { LoadedDay, loadDatabase, skippedFile, skippedLine, uncategorizedFiles } from "../src/core/reports";

const DB = loadDatabase("gym:\n  category: personal\n  keywords: [gym]\nlost: [lost]\n");
const PROJECTS = { gym: ["gym"], lost: ["lost"] };

// A day file as the folder gives it: parser output JSON under the Markdown name.
function day(name: string, tasks: string[]): LoadedDay {
  const text = ["11/11", ...tasks].join("\n");
  return { name, text: JSON.stringify(parseDay(text, { projects: PROJECTS, defaultYear: 2026 })) };
}

test("a skipped line names its file and line", () => {
  assert.deepEqual(skippedLine("Toggl-20-11-1369.md: line 3: expected a task such as '- [ ] 859 watch tv'"), {
    name: "Toggl-20-11-1369.md",
    line: 3,
  });
});

test("skipped items without a line are not links", () => {
  assert.equal(skippedLine("notes.json: not JSON"), null);
  assert.equal(skippedLine("Toggl-20-11-1369.md: Reports needs JSON"), null);
  assert.equal(skippedLine("projects.yml: line 2: bad"), null);
  assert.equal(skippedLine("bad date \"2026-13-01\""), null);
});

test("uncategorised files are those with an entry that has no category", () => {
  const files = [
    day("a.md", ["- [ ] 859 gym"]), // categorised
    day("b.md", ["- [ ] 859 gym", "- [ ] 1000 lost"]), // a project with no category
    day("c.md", ["- [ ] 859 gym", "- [ ] 1000 lunch"]), // no project at all
  ];
  assert.deepEqual(uncategorizedFiles(files, DB), ["b.md", "c.md"]);
});

test("a file that is not a day is not listed as uncategorised", () => {
  assert.deepEqual(uncategorizedFiles([{ name: "x.md", text: "not json" }], DB), []);
});

test("a skipped item names its day file, with or without a line", () => {
  assert.equal(skippedFile("Toggl-20-11-1369.md: line 3: expected a task such as '- [ ] 859 watch tv'"), "Toggl-20-11-1369.md");
  assert.equal(skippedFile("Toggl-20-11-1369.md: Reports needs JSON"), "Toggl-20-11-1369.md");
  assert.equal(skippedFile("notes.json: not JSON"), null);
  assert.equal(skippedFile("projects.yml: line 2: bad"), null);
  assert.equal(skippedFile("bad date \"2026-13-01\""), null);
});
