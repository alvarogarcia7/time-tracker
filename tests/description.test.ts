import test from "node:test";
import assert from "node:assert/strict";

import { detectProject, parseDescription, Projects } from "../src/core/description";
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

// ---- the comma tag: the project is the text after the last comma ----------------------

test("task, project gives the project, and the task as written before the comma", () => {
  assert.deepEqual(parts("wash dishes, kitchen"), { project: "kitchen", task: "wash dishes", form: "tag" });
});

test("the tag is matched ignoring case and surrounding spaces", () => {
  assert.deepEqual(parts("Wash,  KITCHEN "), { project: "kitchen", task: "Wash", form: "tag" });
});

test("the task may contain commas: only the last comma separates the project", () => {
  assert.deepEqual(parts("watch tv, a, lost"), { project: "lost", task: "watch tv, a", form: "tag" });
});

test("the task is kept as written: inner spaces, punctuation and case", () => {
  assert.equal(parts("Wash  dishes, now!, KITCHEN").task, "Wash  dishes, now!");
});

test("a keyword of several words as the tag", () => {
  assert.deepEqual(parts("call, client-a team"), { project: "client", task: "call", form: "tag" });
});

test("a tag gives its project even when the task names another project", () => {
  assert.deepEqual(parts("call lost, kitchen"), { project: "kitchen", task: "call lost", form: "tag" });
});

test("a comma tag that matches no project is unknown, and the task is the text before the comma", () => {
  assert.deepEqual(parts("wash dishes, nothing"), { project: "unknown", task: "wash dishes", form: "tag" });
});

test("the left-side form is no longer a tag: kitchen, wash dishes is unknown with task kitchen", () => {
  assert.deepEqual(parts("kitchen, wash dishes"), { project: "unknown", task: "kitchen", form: "tag" });
});

test("a colon splits: kitchen: wash dishes and wash dishes: kitchen give kitchen and the other side as the task", () => {
  assert.deepEqual(parts("kitchen: wash dishes"), { project: "kitchen", task: "wash dishes", form: "keyword-first" });
  assert.deepEqual(parts("wash dishes: kitchen"), { project: "kitchen", task: "wash dishes", form: "keyword-last" });
});

test("a colon form works with a keyword that is the parent of a project: car: wash is car:maintainance", () => {
  assert.deepEqual(parseDescription("car: wash", CAR), { project: "car:maintainance", task: "wash", form: "keyword-first", separatorAt: 3 });
  assert.deepEqual(parseDescription("wash: car", CAR), { project: "car:maintainance", task: "wash", form: "keyword-last", separatorAt: 4 });
});

test("the comma tag wins over a colon: wash: car, kitchen is kitchen with the task wash: car", () => {
  assert.deepEqual(parts("wash: car, kitchen"), { project: "kitchen", task: "wash: car", form: "tag" });
});

test("two different projects on the two sides of a colon are an error", () => {
  expectThrows(() => parts("kitchen: gym"), /matches several projects/);
});

test("gym, gym gives gym with the task gym", () => {
  assert.deepEqual(parts("gym, gym"), { project: "gym", task: "gym", form: "tag" });
});

test("a tag is one project: the text before the comma is not checked for keywords", () => {
  assert.deepEqual(parts("gym, lost"), { project: "lost", task: "gym", form: "tag" });
});

test("a trailing comma with an empty tag is no tag", () => {
  assert.deepEqual(parts("kitchen wash,"), { project: "kitchen", task: "kitchen wash,", form: "keyword" });
});

// ---- no comma: the keyword search over the whole description ---------------------------

test("a description with no comma and a keyword gets that project, the whole description as the task", () => {
  assert.deepEqual(parts("kitchen wash"), { project: "kitchen", task: "kitchen wash", form: "keyword" });
});

test("a keyword inside a split-looking text is still found as a whole word", () => {
  assert.deepEqual(parts("kitchen cleaning: wash"), { project: "kitchen", task: "kitchen cleaning: wash", form: "keyword" });
});

test("no comma and no keyword gives unknown, and the whole description as the task", () => {
  assert.deepEqual(parts("walking"), { project: "unknown", task: "walking", form: "none" });
});

test("a part that is only part of a keyword is not a keyword", () => {
  assert.deepEqual(parts("kitchens: x"), { project: "unknown", task: "kitchens: x", form: "none" });
});

test("two unrelated projects that both match are an error, whatever their keyword lengths", () => {
  expectThrows(() => detectProject("kitchen gym", PROJECTS), /matches several projects/);
});

// ---- unrelated keywords of the same depth: no ranking by length -----------------------

const CARS: Projects = new Map([
  ["car", ["car"]],
  ["car maintenance", ["car maintenance"]],
]);

test("two unrelated keywords that both match are an error, even when one is longer", () => {
  expectThrows(() => detectProject("car maintenance", CARS), /matches several projects: car, car maintenance/);
  expectThrows(() => parseDescription("oil change car maintenance", CARS), /matches several projects/);
});

test("the comma tag still picks one keyword exactly", () => {
  assert.equal(parseDescription("oil, car maintenance", CARS).project, "car maintenance");
  assert.equal(parseDescription("oil, car", CARS).project, "car");
});

test("car alone is still car", () => {
  assert.equal(detectProject("car wash", CARS), "car");
  assert.equal(parseDescription("oil, car", CARS).project, "car");
});

test("an exact tie in length across unrelated projects is an error", () => {
  const tied: Projects = new Map([
    ["gym", ["gym"]],
    ["fun", ["fun"]],
  ]);

  expectThrows(() => detectProject("gym fun", tied), /matches several projects: gym, fun/);
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

test("unrelated projects that both match with the same length are still an error", () => {
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
  // car:a matches "a" itself, car:b only through car: at the same depth the own keyword wins
  assert.equal(detectProject("car a", projects), "car:a");
  assert.equal(detectProject("a", projects), "car:a");
  // car:a and car:b both match only through car: the description names the parent itself
  assert.equal(detectProject("car", projects), "car");
  assert.equal(parseDescription("wash, car", projects).project, "car");
  assert.equal(parseDescription("car: wash", projects).project, "car");
});

test("a parent keyword that several children inherit is the parent", () => {
  const projects: Projects = new Map([
    ["kitchen", ["kitchen"]],
    ["kitchen:orca", ["kitchen:orca"]],
    ["kitchen:weight", ["kitchen:weight"]],
  ]);

  assert.equal(detectProject("kitchen", projects), "kitchen");
  assert.equal(detectProject("kitchen:weight", projects), "kitchen:weight");
});

test("a child with its own keyword beats its sibling that matches only through the parent: car a is car:a", () => {
  const projects: Projects = new Map([
    ["car", ["car"]],
    ["car:a", ["a"]],
    ["car:b", ["b"]],
  ]);

  assert.deepEqual(parseDescription("car a", projects), { project: "car:a", task: "car a", form: "keyword" });
});

test("an entry is parsed with the description rules", () => {
  const entry = parseDay("#toggl 11/11\n- [ ] 0800 wash dishes, kitchen\n- [ ] 0900 \n", {
    projects: { kitchen: ["kitchen"] },
    defaultYear: 2026,
    parsedAt: "2026-11-11T12:00:00+04:00",
  }).entries[0];

  assert.equal(entry.description, "wash dishes, kitchen");
  assert.equal(entry.task, "wash dishes");
  assert.equal(entry.project, "kitchen");
});

test("a reference copies the description, and the rules apply to the copy", () => {
  const entries = parseDay("#toggl 11/11\n- [ ] 0800 wash, kitchen\n- [ ] 0900 8\n- [ ] 1000 \n", {
    projects: { kitchen: ["kitchen"] },
    defaultYear: 2026,
    parsedAt: "2026-11-11T12:00:00+04:00",
  }).entries;

  assert.equal(entries[1].task, "wash");
  assert.equal(entries[1].project, "kitchen");
});

test("a parent keyword shared by children is the parent, unless another project matches on its own", () => {
  const projects: Projects = new Map([
    ["car", ["car"]],
    ["car:a", ["car:a"]],
    ["car:b", ["car:b"]],
    ["gym", ["gym"]],
  ]);

  assert.equal(detectProject("car", projects), "car");
  assert.throws(() => detectProject("gym car", projects), /gym/);
  // A child named on its own still wins over the parent.
  assert.equal(detectProject("car car:b", projects), "car:b");
});
