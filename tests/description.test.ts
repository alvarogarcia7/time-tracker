import test from "node:test";
import assert from "node:assert/strict";

import { detectProject, parseDescription, Projects, replaceKeyword } from "../src/core/description";
import { TimeParseError } from "../src/core/errors";
import { parseDay } from "../src/core/parser";

const PROJECTS: Projects = new Map([
  ["kitchen", ["kitchen"]],
  ["lost", ["lost"]],
  ["client", ["client-a team"]],
  ["gym", ["gym"]],
]);

const parts = (description: string) => {
  const { project, task, form } = parseDescription(description, PROJECTS);
  return { project, task, form };
};

function expectThrows(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => err instanceof TimeParseError && pattern.test((err as Error).message));
}

test("kitchen: task gives the project, and the task as written", () => {
  assert.deepEqual(parts("kitchen: wash dishes"), { project: "kitchen", task: "wash dishes", form: "keyword-first" });
});

test("kitchen, task gives the same", () => {
  assert.deepEqual(parts("kitchen, wash dishes"), { project: "kitchen", task: "wash dishes", form: "keyword-first" });
});

test("task, kitchen gives the same", () => {
  assert.deepEqual(parts("wash dishes, kitchen"), { project: "kitchen", task: "wash dishes", form: "keyword-last" });
});

test("task: kitchen gives the same", () => {
  assert.deepEqual(parts("wash dishes: kitchen"), { project: "kitchen", task: "wash dishes", form: "keyword-last" });
});

test("the keyword is matched ignoring case", () => {
  assert.equal(parts("KITCHEN: wash").project, "kitchen");
  assert.equal(parts("Wash, Kitchen").project, "kitchen");
});

test("a keyword of several words", () => {
  assert.deepEqual(parts("client-a team: call"), { project: "client", task: "call", form: "keyword-first" });
});

test("the task is kept as written: inner spaces, punctuation and case", () => {
  assert.equal(parts("kitchen: Wash  dishes, now!").task, "Wash  dishes, now!");
});

test("the task may contain a comma: the split is tried at the first and the last comma", () => {
  assert.deepEqual(parts("watch tv, a, lost"), { project: "lost", task: "watch tv, a", form: "keyword-last" });
});

test("the keyword side gives the project even when the task names another project", () => {
  assert.deepEqual(parts("kitchen: call lost"), { project: "kitchen", task: "call lost", form: "keyword-first" });
});

test("a keyword in the middle of the text, with no split, is found as a whole word", () => {
  assert.deepEqual(parts("kitchen wash"), { project: "kitchen", task: "kitchen wash", form: "anywhere" });
});

test("no keyword gives unknown, and the whole description as the task", () => {
  assert.deepEqual(parts("walking"), { project: "unknown", task: "walking", form: "none" });
});

test("a part that is only part of a keyword is not a keyword", () => {
  assert.deepEqual(parts("kitchens: x"), { project: "unknown", task: "kitchens: x", form: "none" });
});

test("a split whose sides are not keywords falls back to the whole-word search", () => {
  assert.deepEqual(parts("kitchen cleaning: wash"), { project: "kitchen", task: "kitchen cleaning: wash", form: "anywhere" });
});

test("keywords of two projects on the two sides are an error", () => {
  expectThrows(() => parts("gym, lost"), /matches several projects: gym, lost/);
});

test("the same keyword on both sides is fine", () => {
  assert.deepEqual(parts("gym, gym"), { project: "gym", task: "gym", form: "keyword-first" });
});

test("an entry is parsed with the description rules", () => {
  const entry = parseDay("#toggl 11/11\n- [ ] 0800 kitchen: wash dishes\n- [ ] 0900 \n", {
    projects: { kitchen: ["kitchen"] },
    defaultYear: 2026,
    parsedAt: "2026-11-11T12:00:00+04:00",
  }).entries[0];

  assert.equal(entry.description, "kitchen: wash dishes");
  assert.equal(entry.task, "wash dishes");
  assert.equal(entry.project, "kitchen");
});

test("a reference copies the description, and the rules apply to the copy", () => {
  const entries = parseDay("#toggl 11/11\n- [ ] 0800 kitchen: wash\n- [ ] 0900 8\n- [ ] 1000 \n", {
    projects: { kitchen: ["kitchen"] },
    defaultYear: 2026,
    parsedAt: "2026-11-11T12:00:00+04:00",
  }).entries;

  assert.equal(entries[1].task, "wash");
  assert.equal(entries[1].project, "kitchen");
});

test("replaceKeyword changes the keyword side and keeps the separator and the task", () => {
  const first = parseDescription("kitchen: wash dishes", PROJECTS);
  assert.equal(replaceKeyword("kitchen: wash dishes", first, "gym"), "gym: wash dishes");
  const last = parseDescription("wash dishes,  kitchen ", PROJECTS);
  assert.equal(replaceKeyword("wash dishes,  kitchen ", last, "gym"), "wash dishes,  gym ");
  const none = parseDescription("walking", PROJECTS);
  assert.equal(replaceKeyword("walking", none, "gym"), "walking");
});

// ---- hierarchy: a keyword of a project also matches the projects below it ------------

const CAR: Projects = new Map([
  ["car:maintainance", ["car:maintainance"]],
  ["car", ["car"]],
]);

test("a keyword of a parent project matches the child, and the deepest project wins", () => {
  assert.equal(detectProject("car", CAR), "car:maintainance");
  assert.equal(detectProject("car wash", CAR), "car:maintainance");
  assert.equal(parseDescription("car: wash", CAR).project, "car:maintainance");
  assert.equal(parseDescription("wash, car", CAR).project, "car:maintainance");
});

test("a keyword with a colon matches the whole description, not its first part", () => {
  const parts = parseDescription("car:maintainance", CAR);

  assert.equal(parts.project, "car:maintainance");
  assert.equal(parts.task, "car:maintainance");
});

test("unrelated projects that both match are still an error", () => {
  const projects: Projects = new Map([
    ["gym", ["gym"]],
    ["car:maintainance", ["car:maintainance"]],
    ["car", ["car"]],
  ]);

  assert.throws(() => detectProject("gym car", projects), /matches several projects/);
});

test("two children of the same parent that both match are an error", () => {
  const projects: Projects = new Map([
    ["car", ["car"]],
    ["car:a", ["a"]],
    ["car:b", ["b"]],
  ]);

  assert.throws(() => detectProject("car a b", projects), /matches several projects/);
  assert.equal(detectProject("car a", projects), "car:a");
});
