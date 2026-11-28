import test from "node:test";
import assert from "node:assert/strict";

import { daysBetween, dayTotals, mondayOf, summarizeWeek, weekDates } from "../src/core/week";
import { Entry, TimeEntryDay, formatShare, projectTree, tasksOf } from "../src/core/summary";

const entry = (project: string, minutes: number | null, description = "x"): Entry => ({
  line: 1,
  source: "08:00",
  start: "08:00",
  end: minutes === null ? null : "09:00",
  start_type: "absolute",
  time_expression: "8",
  duration_minutes: minutes,
  description,
  project,
  reference: null,
});

const day = (date: string, entries: Entry[]): TimeEntryDay => ({
  date,
  parsed_at: "",
  original_text: "",
  parser_version: "",
  tag: null,
  entries,
  schema: "",
});

// ---- share of the total -----------------------------------------------------------

test("the share is the minutes over the total, as a whole percentage", () => {
  // 1h 3m against 1h: 63 / 123 is 51.2%, so 51%; the other part is 49%.
  assert.equal(formatShare(63, 123), "51%");
  assert.equal(formatShare(60, 123), "49%");
  assert.equal(formatShare(120, 120), "100%");
});

test("a share above zero that rounds to 0% shows as <1%, and an empty total as 0%", () => {
  assert.equal(formatShare(1, 1000), "<1%");
  assert.equal(formatShare(0, 500), "0%");
  assert.equal(formatShare(0, 0), "0%");
});

// ---- the project hierarchy ----------------------------------------------------------

test("a project name with colons is nested, and each parent is the subtotal of what is below it", () => {
  const tree = projectTree([
    entry("a:b:c", 60),
    entry("a:b:d", 30),
    entry("a:e", 30),
    entry("f", 90),
  ]);

  assert.deepEqual(tree.map((node) => node.path), ["a", "f"]); // a has 120, f has 90
  const a = tree[0];
  assert.equal(a.minutes, 120);
  assert.equal(a.label, "a");
  assert.deepEqual(a.children.map((node) => [node.path, node.minutes]), [
    ["a:b", 90],
    ["a:e", 30],
  ]);
  const b = a.children[0];
  assert.equal(b.depth, 1);
  assert.deepEqual(b.children.map((node) => [node.path, node.minutes, node.label]), [
    ["a:b:c", 60, "c"],
    ["a:b:d", 30, "d"],
  ]);
});

test("a project that is also a parent keeps its own entries and adds its sub-projects to its total", () => {
  const [gym] = projectTree([entry("gym", 30), entry("gym:yoga", 60)]);
  assert.equal(gym.minutes, 90);
  assert.equal(gym.own.length, 1);
  assert.equal(gym.children[0].path, "gym:yoga");
});

test("unknown comes last at the top, and open entries count without minutes", () => {
  const tree = projectTree([entry("unknown", 500), entry("x", 10), entry("x", null)]);
  assert.deepEqual(tree.map((node) => node.path), ["x", "unknown"]);
  assert.equal(tree[0].open, 1);
  assert.equal(tree[0].count, 2);
});

test("the tasks of a project are grouped by description, most time first", () => {
  const tasks = tasksOf([entry("p", 30, "review"), entry("p", 60, "dev"), entry("p", 15, "review"), entry("p", 5, "  ")]);
  assert.deepEqual(
    tasks.map((task) => [task.description, task.minutes, task.count]),
    [
      ["dev", 60, 1],
      ["review", 45, 2],
      ["(no description)", 5, 1],
    ],
  );
});

// ---- the week ---------------------------------------------------------------------

test("the week of a day runs from its Monday to its Sunday", () => {
  assert.equal(mondayOf("2026-11-09"), "2026-11-09"); // a Monday is its own week's start
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // a Sunday ends the week
  assert.equal(mondayOf("2026-11-21"), "2026-11-16");
  assert.deepEqual(weekDates("2026-11-09").slice(0, 2), ["2026-11-09", "2026-11-10"]);
  assert.equal(weekDates("2026-11-09").length, 7);
});

test("the week adds up its days, and leaves out files of other weeks", () => {
  const week = summarizeWeek(
    [
      day("2026-11-09", [entry("client-b", 480)]),
      day("2026-11-10", [entry("client-b", 240), entry("gym", 60)]),
      day("2026-11-11", [entry("gym", null)]),
      day("2026-11-16", [entry("client-b", 999)]), // the next week
    ],
    "2026-11-09",
  );

  assert.equal(week.label, "2026-W46");
  assert.equal(week.sunday, "2026-11-15");
  assert.equal(week.minutes, 780);
  assert.equal(week.count, 4);
  assert.equal(week.open, 1);
  assert.equal(week.daysWithEntries, 3);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].minutes, 480);
  assert.equal(week.days[1].byProject.get("gym"), 60);
  assert.equal(week.days[2].minutes, 0);
  assert.equal(week.days[2].entries, 1);
  assert.equal(week.days[6].entries, 0);
});

test("an empty week has no days with entries", () => {
  const week = summarizeWeek([], "2026-11-09");
  assert.equal(week.minutes, 0);
  assert.equal(week.daysWithEntries, 0);
});

// ---- the days of a range, for the reports' duration by day -------------------------

test("a range lists its days from the first to the last, both included", () => {
  assert.deepEqual(daysBetween("2026-11-09", "2026-11-11"), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.deepEqual(daysBetween("2026-11-30", "2026-11-30"), ["2026-11-30"]);
  assert.deepEqual(daysBetween("2026-11-11", "2026-11-09"), []);
});

test("the day totals count the records of the listed days only", () => {
  const days = dayTotals(
    [
      { day: "2026-11-09", project: "client-b", minutes: 480 },
      { day: "2026-11-10", project: "client-b", minutes: 240 },
      { day: "2026-11-10", project: "gym", minutes: 60 },
      { day: "2026-11-11", project: "gym", minutes: null }, // open: counted, without minutes
      { day: "2026-11-20", project: "gym", minutes: 999 }, // outside the range
    ],
    daysBetween("2026-11-09", "2026-11-11"),
  );

  assert.deepEqual(
    days.map((day) => [day.date, day.minutes, day.entries]),
    [
      ["2026-11-09", 480, 1],
      ["2026-11-10", 300, 2],
      ["2026-11-11", 0, 1],
    ],
  );
  assert.equal(days[1].byProject.get("gym"), 60);
  assert.equal(days[2].byProject.size, 0);
});
