import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_PERIOD,
  DEFAULT_PRESET,
  PERIODS,
  presetForPeriod,
  EntryRecord,
  addDays,
  buildReport,
  checkSelection,
  detectProjectInDb,
  loadDatabase,
  periodKey,
  recordsFromFiles,
  splitList,
  uncategorizedDetails,
} from "../src/core/reports";

// Paths are relative to dist-test/, where the bundled tests run.
const repo = join(__dirname, "..");
const read = (path: string) => readFileSync(path, "utf-8");
const exampleDb = () => loadDatabase(read(join(repo, "tests/fixtures/sample/projects.yml")), "tests/fixtures/sample/projects.yml");
const fixture = (name: string) => JSON.parse(read(join(__dirname, "../tests/fixtures", name)));

function rec(day: string, minutes: number | null, project = "unknown", category: EntryRecord["category"] = null): EntryRecord {
  return { day, start: "08:00", minutes, description: "x", project, category };
}

const sample = (): EntryRecord[] => [
  rec("2026-01-15", 60, "gym", "personal"),
  rec("2026-01-20", 30, "client-b:review", "professional"),
  rec("2026-02-03", 90, "client-b:api-review", "professional"),
  rec("2026-02-03", null, "unknown"),
  rec("2026-02-10", 45, "client-b:review:design", "professional"),
  rec("2026-02-11", 15, "unknown"),
];

// ---- database ---------------------------------------------------------------

test("loadDatabase reads categories, keyword-only projects, and hierarchical names", () => {
  const db = loadDatabase(
    'gym:\n  category: personal\n  keywords: [gym, workout]\n"client-b:api-review":\n  category: professional\n  keywords: ["API review"]\nlost: [lost]\n',
  );

  assert.equal(db.get("gym")?.category, "personal");
  assert.deepEqual(db.get("gym")?.keywords, ["gym", "workout"]);
  assert.equal(db.get("client-b:api-review")?.category, "professional");
  assert.equal(db.get("lost")?.category, null);
});

test("loadDatabase rejects an invalid category, unknown fields, and shared keywords", () => {
  assert.throws(() => loadDatabase("gym:\n  category: hobby\n  keywords: [gym]\n"), /personal or professional/);
  assert.throws(() => loadDatabase("gym:\n  categroy: personal\n  keywords: [gym]\n"), /unknown field categroy/);
  assert.throws(() => loadDatabase("gym: [workout]\nfitness: [Workout]\n"), /maps to both/);
  assert.throws(() => loadDatabase("unknown: [x]\n"), /reserved/);
});

test("loadDatabase accepts an empty file", () => {
  assert.equal(loadDatabase("").size, 0);
});

test("the example database loads the same as the Python loader", () => {
  const db = exampleDb();

  assert.deepEqual([...db.keys()], ["lost", "gym", "client-a", "deep-work"]);
  assert.equal(db.get("client-a")?.category, "professional");
});

test("detectProject matches whole words ignoring case, and refuses two projects", () => {
  const db = exampleDb();

  assert.equal(detectProjectInDb("watch TV, Lost", db), "lost");
  assert.equal(detectProjectInDb("lostness", db), "unknown");
  assert.equal(detectProjectInDb("call Client-A Team", db), "client-a");

  const clash = loadDatabase("a: [alpha]\nb: [bravo]\n");
  assert.throws(() => detectProjectInDb("alpha bravo", clash), /matches several projects: a, b/);
});

// ---- periods ----------------------------------------------------------------

test("periodKey matches the Python keys for each period", () => {
  assert.equal(periodKey("2026-11-11", "daily"), "2026-11-11");
  assert.equal(periodKey("2026-11-11", "weekly"), "2026-W46");
  assert.equal(periodKey("2026-11-11", "monthly"), "2026-11");
  assert.equal(periodKey("2026-11-11", "quarterly"), "2026-Q4");
  assert.equal(periodKey("2026-11-11", "yearly"), "2026");
});

test("weeks follow the ISO calendar across the new year", () => {
  assert.equal(periodKey("2027-01-01", "weekly"), "2026-W53");
  assert.equal(periodKey("2026-01-01", "weekly"), "2026-W01");
  assert.equal(periodKey("2027-01-04", "weekly"), "2027-W01");
});

test("addDays steps across month and year ends", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});

// ---- report -----------------------------------------------------------------

test("totals count open entries separately", () => {
  const report = buildReport(sample(), "monthly");

  assert.deepEqual(report.totals, { hours: 4, entries: 6, open_entries: 1, days: 5 });
});

test("monthly buckets include empty months inside the range", () => {
  const report = buildReport(sample(), "monthly", { start: "2026-01-01", end: "2026-03-31" });

  assert.deepEqual(
    report.by_period.map((p) => [p.period, p.hours, p.entries]),
    [
      ["2026-01", 1.5, 2],
      ["2026-02", 2.5, 4],
      ["2026-03", 0, 0],
    ],
  );
});

test("daily buckets cover every day of the range", () => {
  const report = buildReport(sample(), "daily", { start: "2026-02-02", end: "2026-02-04" });

  assert.deepEqual(report.by_period.map((p) => p.period), ["2026-02-02", "2026-02-03", "2026-02-04"]);
  assert.equal(report.by_period[1].open_entries, 1);
});

test("range defaults to the data", () => {
  const report = buildReport(sample(), "yearly");

  assert.equal(report.from, "2026-01-15");
  assert.equal(report.to, "2026-02-11");
});

test("a reversed range is rejected", () => {
  assert.throws(() => buildReport(sample(), "monthly", { start: "2026-03-01", end: "2026-02-01" }), /after/);
});

test("project names and prefixes select projects; a prefix does not match a partial name", () => {
  assert.deepEqual(
    buildReport(sample(), "monthly", { names: ["gym", "unknown"] }).by_project.map((p) => p.project),
    ["gym", "unknown"],
  );
  assert.deepEqual(
    buildReport(sample(), "monthly", { prefixes: ["client-b"] }).by_project.map((p) => p.project),
    ["client-b:api-review", "client-b:review:design", "client-b:review"],
  );
  const partial = [rec("2026-01-01", 60, "client-b:review"), rec("2026-01-01", 60, "tiny")];
  assert.deepEqual(buildReport(partial, "monthly", { prefixes: ["ti"] }).by_project, []);
});

test("category filter keeps uncategorised projects", () => {
  const records = [rec("2026-01-01", 60, "gym", "personal"), rec("2026-01-01", 30, "tiny", null), rec("2026-01-01", 90, "client-b:review", "professional")];

  const report = buildReport(records, "monthly", { category: "personal" });

  assert.deepEqual(report.by_project.map((p) => p.project), ["gym", "tiny"]);
  assert.equal(report.totals.hours, 1.5);
});

test("shares are of closed time", () => {
  const report = buildReport(sample(), "monthly", { names: ["gym", "client-b:review"] });

  assert.deepEqual(
    Object.fromEntries(report.by_project.map((p) => [p.project, p.share_percent])),
    { gym: 66.7, "client-b:review": 33.3 },
  );
});

test("an empty selection gives an empty report", () => {
  const report = buildReport([], "monthly");

  assert.deepEqual(report.by_period, []);
  assert.deepEqual(report.totals, { hours: 0, entries: 0, open_entries: 0, days: 0 });
});

test("checkSelection rejects unknown names, prefixes and categories", () => {
  const db = exampleDb();

  assert.throws(() => checkSelection(db, ["gmy"], [], undefined), /unknown project "gmy"/);
  assert.throws(() => checkSelection(db, [], ["nope"], undefined), /no registered project matches prefix/);
  assert.doesNotThrow(() => checkSelection(db, ["unknown"], [], "personal"));
});

test("splitList splits comma-separated arguments", () => {
  assert.deepEqual(splitList(" gym, client-b:review ,"), ["gym", "client-b:review"]);
  assert.deepEqual(splitList(""), []);
});

// ---- files ------------------------------------------------------------------

test("recordsFromFiles matches projects against the database and skips other JSON", () => {
  const files = ["day.json", "week-day.json"].map((name) => ({
    name,
    text: read(join(repo, "tests/fixtures/sample/expected", name)),
  }));
  const extra = [...files, { name: "other.json", text: '{"hello": 1}' }, { name: "broken.json", text: "{" }];

  const { records, skipped } = recordsFromFiles(extra, exampleDb());

  assert.equal(records.length, 4 + 7);
  assert.equal(records.find((r) => r.description === "watch tv, lost")?.project, "lost");
  assert.deepEqual(skipped, ["other.json: not a time-entry file", "broken.json: not JSON"]);
});

test("recordsFromFiles rejects a file with a bad date", () => {
  const text = JSON.stringify({ date: "11/11", entries: [] });

  assert.deepEqual(recordsFromFiles([{ name: "x.json", text }], exampleDb()).skipped, ['x.json: bad date "11/11"']);
});

// ---- parity with the Python reports -----------------------------------------

function parityFiles() {
  const dir = join(repo, "tests/fixtures/sample/expected");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: read(join(dir, name)) }));
}

test("daily report matches the Python report on the same files", () => {
  const { records, skipped } = recordsFromFiles(parityFiles(), exampleDb());

  assert.deepEqual(buildReport(records, "daily", {}, skipped), fixture("report-daily.json"));
});

test("weekly report for professional projects matches the Python report", () => {
  const { records, skipped } = recordsFromFiles(parityFiles(), exampleDb());

  assert.deepEqual(
    buildReport(records, "weekly", { category: "professional" }, skipped),
    fixture("report-weekly-professional.json"),
  );
});

test("each period brings the range that fits it, and daily shows the current week", () => {
  assert.equal(DEFAULT_PERIOD, "daily");
  assert.equal(DEFAULT_PRESET, "this-week");
  assert.deepEqual(
    PERIODS.map((period) => presetForPeriod(period)),
    ["this-week", "this-week", "this-month", "this-quarter", "this-half", "this-year"],
  );
});

test("the days without a category say which entry and why", () => {
  const db = loadDatabase("work:\n  category: professional\n  keywords: [work]\nfree:\n  keywords: [free]\n");
  const day = (text: string) => JSON.stringify({ date: "2026-11-12", parsed_at: "", original_text: "", parser_version: "", tag: null, schema: "", entries: JSON.parse(text) });
  const entry = (start: string, end: string | null, description: string, project: string) =>
    ({ line: 2, source: "", start, end, start_type: "absolute", time_expression: start, duration_minutes: end ? 30 : null, description, task: description, project, reference: null });
  const files = [
    { name: "a.json", text: day(JSON.stringify([entry("09:00", "09:30", "emails, work", "work"), entry("09:30", "10:00", "xyzzy", "unknown"), entry("10:00", "10:30", "tidy, free", "free"), entry("10:30", null, "", "unknown")])) },
    { name: "b.json", text: day(JSON.stringify([entry("09:00", "09:30", "emails, work", "work")])) },
  ];

  assert.deepEqual(uncategorizedDetails(files, db), [
    { name: "a.json", reasons: ["09:30: “xyzzy” has no project", "10:00: project free has no category", "10:30: an empty entry"] },
  ]);
});
