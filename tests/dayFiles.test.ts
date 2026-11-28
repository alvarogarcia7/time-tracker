import test from "node:test";
import assert from "node:assert/strict";

import { chooseDayFile, dayListEntries, dayWithWeekday, fileInUrl, headerDate, localDay, markdownPickMessage, newestFirst, shortcutFiles, urlWithFile } from "../src/core/dayFiles";

test("the date of a day file is read from its header, with or without a tag and a year", () => {
  assert.equal(headerDate("#toggl 11/11\n- [ ] 0800 a\n", 2026), "2026-11-11");
  assert.equal(headerDate("\n  toggl 6/5/2025 Partial\n", 2026), "2025-05-06");
  assert.equal(headerDate("# 3/2\n", 2026), "2026-02-03");
});

test("a file without a valid header has no date", () => {
  assert.equal(headerDate("Notes from Monday\n", 2026), null);
  assert.equal(headerDate("31/02\n", 2026), null);
  assert.equal(headerDate("", 2026), null);
});

test("newest first by date, files without a date last, then later names first", () => {
  const files = [
    { name: "a.md", date: "2026-11-01" },
    { name: "notes.md", date: null },
    { name: "c.md", date: "2026-11-20" },
    { name: "b.md", date: "2026-11-20" },
  ];
  assert.deepEqual(newestFirst(files).map((file) => file.name), ["c.md", "b.md", "a.md", "notes.md"]);
});

test("the file named in the URL is chosen when it is in the folder, otherwise the newest", () => {
  const files = [
    { name: "11-01.md", date: "2026-11-01" },
    { name: "11-20.md", date: "2026-11-20" },
  ];
  assert.equal(chooseDayFile(files, "11-01.md")?.name, "11-01.md");
  assert.equal(chooseDayFile(files, "deleted.md")?.name, "11-20.md");
  assert.equal(chooseDayFile(files, null)?.name, "11-20.md");
  assert.equal(chooseDayFile([], null), undefined);
});

test("the file in the URL is read and written as ?name=, keeping the tab in the hash", () => {
  assert.equal(fileInUrl("http://127.0.0.1:8001/?name=11-20.md#viewer"), "11-20.md");
  assert.equal(fileInUrl("http://127.0.0.1:8001/#editor"), null);
  assert.equal(
    urlWithFile("http://127.0.0.1:8001/?name=a.md#viewer", "b c.md"),
    "http://127.0.0.1:8001/?name=b+c.md#viewer",
  );
  assert.equal(fileInUrl(urlWithFile("http://127.0.0.1:8001/#reports", "d & e.md")), "d & e.md");
});

test("the local day is YYYY-MM-DD", () => {
  assert.equal(localDay(new Date(2026, 10, 3, 23, 59)), "2026-11-03");
});

test("the shortcuts are the newest file and today's file, and today's is missing when no file has today's date", () => {
  const files = [
    { name: "a.md", date: "2026-11-01" },
    { name: "b.md", date: "2026-11-23" },
    { name: "c.md", date: null },
  ];
  assert.equal(shortcutFiles(files, "2026-11-23").last?.name, "b.md");
  assert.equal(shortcutFiles(files, "2026-11-23").today?.name, "b.md");
  assert.equal(shortcutFiles(files, "2026-11-24").today, undefined);
  assert.equal(shortcutFiles([], "2026-11-24").last, undefined);
});

test("a day's date is shown with its weekday, as in the file picker", () => {
  assert.equal(dayWithWeekday("2026-11-23"), "Mon 2026-11-23");
  assert.equal(dayWithWeekday("2026-11-29"), "Sun 2026-11-29");
});

test("the day list holds the files that parse and the day files that fail, marked, but not the project database error", () => {
  const list = dayListEntries(
    [{ name: "a.md" }, { name: "c.md" }],
    [{ name: "b.md" }, { name: "projects.yml" }],
  );
  assert.deepEqual(list, [
    { name: "a.md", failed: false },
    { name: "b.md", failed: true },
    { name: "c.md", failed: false },
  ]);
});

test("the Viewer says a Markdown day file is picked from the day list, and accepts other files", () => {
  assert.equal(
    markdownPickMessage("2026-11-11.MD"),
    "2026-11-11.MD is a Markdown day file. The Viewer reads parser output JSON: choose the day from the day list instead.",
  );
  assert.equal(markdownPickMessage("11-11.json"), null);
});
