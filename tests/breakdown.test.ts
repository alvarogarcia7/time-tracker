import test from "node:test";
import assert from "node:assert/strict";

import { TaskItem, breakdownRows, projectTree, withPrefixes } from "../src/core/summary";

test("withPrefixes adds every parent of a project once", () => {
  assert.deepEqual(withPrefixes(["a:1", "a:2", "b", "a:1:x"]).sort(), ["a", "a:1", "a:1:x", "a:2", "b"]);
});

const item = (project: string, minutes: number | null, description = "x"): TaskItem => ({
  project,
  duration_minutes: minutes,
  description,
});

const items = [
  item("a:1", 60, "design"),
  item("a:2", 30, "review"),
  item("a", 15, "planning"),
  item("b", 45, "docs"),
];

test("a parent row shows its own time plus its children, and each child is indented under it", () => {
  const rows = breakdownRows(projectTree(items), new Set(["a"]));

  const summary = rows.map((row) => (row.kind === "project" ? [row.path, row.depth, row.minutes] : [row.task.description, row.depth]));
  assert.deepEqual(summary, [
    ["a", 0, 105], // 60 + 30 + 15
    ["a:1", 1, 60],
    ["a:2", 1, 30],
    ["planning", 1],
    ["b", 0, 45],
  ]);
});

test("a collapsed parent hides its children and tasks, and still shows its total", () => {
  const rows = breakdownRows(projectTree(items), new Set());

  assert.deepEqual(
    rows.map((row) => (row.kind === "project" ? [row.path, row.minutes, row.expandable, row.open] : row.kind)),
    [
      ["a", 105, true, false],
      ["b", 45, true, false], // b has its own entries, so it can be opened to show its tasks
    ],
  );
});

test("the tasks of an expanded project sit below its sub-projects, one level deeper", () => {
  const rows = breakdownRows(projectTree(items), new Set(["a", "a:1"]));
  const tasks = rows.filter((row) => row.kind === "task");

  assert.deepEqual(
    tasks.map((row) => (row.kind === "task" ? [row.task.description, row.depth] : [])),
    [
      ["design", 2],
      ["planning", 1],
    ],
  );
});

test("a project with only open entries has no time, and its entries are still listed when expanded", () => {
  const rows = breakdownRows(projectTree([item("idle", null, "waiting")]), new Set(["idle"]));

  assert.deepEqual(
    rows.map((row) => (row.kind === "project" ? [row.path, row.minutes] : [row.task.description, row.task.count])),
    [
      ["idle", 0],
      ["waiting", 1],
    ],
  );
});
