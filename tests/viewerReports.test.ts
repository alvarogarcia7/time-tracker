import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDay, TimeParseError } from "../src/core/parser";
import { loadDatabase, buildReport, EntryRecord, recordsFromFiles, unregisteredSuggestions, Database, rangeLabel } from "../src/core/reports";
import { renderDocument, renderEntries, renderProjects, renderReport, renderTable } from "../src/core/textView";
import { TimeEntryDay, formatMinutes, validate } from "../src/core/summary";

const ROOT = join(__dirname, "..");
const expected = (name: string): TimeEntryDay => validate(JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "sample", "expected", `${name}.json`), "utf-8")));
const DB: Database = loadDatabase("gym:\n  category: personal\n  keywords: [gym]\nlost: [lost]\n");

const rec = (day: string, minutes: number | null, project = "unknown", category: EntryRecord["category"] = null, description = "x"): EntryRecord => ({
  day,
  start: "08:00",
  minutes,
  description,
  project,
  category,
});

// ---- text tables ----------------------------------------------------------------------

test("format of minutes", () => {
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(60), "1h");
  assert.equal(formatMinutes(90), "1h 30m");
  assert.equal(formatMinutes(null), "open");
});

test("a table pads columns and trims the end of each line", () => {
  assert.equal(renderTable(["A", "Bee"], [["xx", "1"], ["y", "22"]]), "A   Bee\nxx  1\ny   22");
});

test("the entries table has every row, and marks open entries", () => {
  const lines = renderEntries(expected("week-day").entries).split("\n");

  assert.deepEqual(lines[0].split(/\s+/), ["Line", "Start", "End", "Duration", "Project", "Description"]);
  assert.equal(lines.length, 1 + 7);
  assert.ok(lines[lines.length - 1].includes("open"));
  assert.ok(lines[6].includes("[relative: -30]"));
});

test("the projects section has a heading with totals, in order", () => {
  const text = renderProjects(expected("week-day").entries);

  assert.ok(text.includes("gym  (1h 30m, 2 entries)"));
  assert.ok(text.includes("unknown  (0m, 1 entry, 1 open)"));
  assert.ok(text.indexOf("gym  (") < text.indexOf("client-a  ("));
});

test("the document has a header, a summary, and both views", () => {
  const text = renderDocument(expected("week-day"));

  assert.ok(text.includes("Date: 2026-11-12"));
  assert.ok(text.includes("Tag: #toggl"));
  assert.ok(text.includes("7 entries, 3h 30m tracked, 1 open"));
  assert.ok(text.includes("Time entries"));
  assert.ok(text.includes("By project"));
});

test("a single view leaves the other out", () => {
  const doc = expected("day");

  assert.ok(renderDocument(doc, "entries").includes("Time entries"));
  assert.ok(!renderDocument(doc, "entries").includes("By project"));
  assert.ok(renderDocument(doc, "projects").includes("By project"));
  assert.ok(!renderDocument(doc, "projects").includes("Time entries"));
});

test("an empty document says none", () => {
  const text = renderDocument({ ...expected("day"), entries: [] });

  assert.ok(text.includes("(none)"));
  assert.ok(text.includes("0 entries"));
});

test("an unknown view is rejected", () => {
  assert.throws(() => renderDocument(expected("day"), "chart" as never), /unknown view/);
});

test("a description is printed as plain text", () => {
  const doc = parseDay("#toggl 11/11\n- [ ] 0800 <b>x</b>\n", { defaultYear: 2026, parsedAt: "2026-11-11T12:00:00+00:00" });

  assert.ok(renderEntries(doc.entries).includes("<b>x</b>"));
});

// ---- reports -------------------------------------------------------------------------

const sample = (): EntryRecord[] => [
  rec("2026-01-15", 60, "gym", "personal"),
  rec("2026-01-20", 30, "client-b:review", "professional"),
  rec("2026-02-03", 90, "client-b:api-review", "professional"),
  rec("2026-02-03", null, "unknown"),
  rec("2026-02-10", 45, "client-b:review:design", "professional"),
  rec("2026-02-11", 15, "unknown"),
];

test("the text report has the header, the period table and the project table", () => {
  const text = renderReport(buildReport(sample(), "monthly"));

  assert.ok(text.startsWith("Report: monthly, 2026-01-15 to 2026-02-11"));
  assert.ok(text.includes("Scope: all projects"));
  assert.ok(text.includes("Total: 4.00 h, 6 entries, 1 open (not counted), 5 days"));
  assert.ok(text.includes("Hours per period"));
  assert.ok(text.includes("Hours per project"));
  assert.ok(text.includes("uncategorised"));
});

test("the Reports header names the range the controls show", () => {
  assert.equal(rangeLabel("2026-01-01", "2026-01-31"), "2026-01-01 to 2026-01-31");
  assert.equal(rangeLabel("2026-01-01", null), "from 2026-01-01");
  assert.equal(rangeLabel(null, "2026-01-31"), "to 2026-01-31");
  assert.equal(rangeLabel(null, null), "no range chosen");
});

test("Reports refuses a .md day file with a plain message and no records", () => {
  const { records, skipped } = recordsFromFiles([{ name: "2026-01-15.md", text: "# 15/01\n\n- [ ] 0800 gym\n" }], DB);

  assert.equal(records.length, 0);
  assert.deepEqual(skipped, ["2026-01-15.md: Reports needs JSON"]);
});

test("skipped files are listed in the text report", () => {
  const text = renderReport(buildReport([], "monthly", {}, ["x.json: not JSON"]));

  assert.ok(text.includes("Skipped files:"));
  assert.ok(text.includes("  x.json: not JSON"));
});

test("unregistered suggestions group by text, ignoring case, most time first", () => {
  const records = [
    rec("2026-01-01", 30, "unknown", null, "Walk"),
    rec("2026-01-01", 45, "unknown", null, "walk"),
    rec("2026-01-01", 120, "unknown", null, "Cooking"),
    rec("2026-01-01", 10, "gym", "personal", "gym"),
    rec("2026-01-01", null, "unknown", null, "Walk"),
  ];

  assert.deepEqual(
    unregisteredSuggestions(records, DB).map((s) => [s.text, s.minutes, s.entries]),
    [
      ["Cooking", 120, 1],
      ["Walk", 75, 3],
    ],
  );
});

test("registered names and empty descriptions are not suggested", () => {
  assert.deepEqual(
    unregisteredSuggestions([rec("2026-01-01", 30, "unknown", null, "GYM"), rec("2026-01-01", 30, "unknown", null, "  ")], DB),
    [],
  );
});

test("a day file that is not JSON or not a time-entry file is skipped and reported", () => {
  const good = JSON.stringify(parseDay("#toggl 11/11\n- [ ] 0800 gym\n", { defaultYear: 2026, parsedAt: "x" }));
  const { records, skipped } = recordsFromFiles(
    [
      { name: "1.json", text: good },
      { name: "other.json", text: '{"hello": 1}' },
      { name: "broken.json", text: "{" },
    ],
    DB,
  );

  assert.equal(records.length, 1);
  assert.deepEqual(skipped, ["other.json: not a time-entry file", "broken.json: not JSON"]);
});

test("an open entry has no minutes", () => {
  const good = JSON.stringify(parseDay("#toggl 11/11\n- [ ] 0800 gym\n", { defaultYear: 2026, parsedAt: "x" }));
  const { records } = recordsFromFiles([{ name: "1.json", text: good }], DB);

  assert.equal(records[0].minutes, null);
});

test("an ambiguous description stops the load and names the file", () => {
  const text = JSON.stringify(parseDay("#toggl 11/11\n- [ ] 0800 gym lost\n", { defaultYear: 2026, parsedAt: "x" }));

  assert.throws(
    () => recordsFromFiles([{ name: "1.json", text }], DB),
    (err: unknown) => err instanceof TimeParseError && /1\.json: .*matches several projects/.test((err as Error).message),
  );
});

test("the projects of records come from the current database", () => {
  const text = JSON.stringify(parseDay("#toggl 11/11\n- [ ] 0800 gym\n", { defaultYear: 2026, parsedAt: "x" }));

  assert.equal(recordsFromFiles([{ name: "1.json", text }], DB).records[0].category, "personal");
});

