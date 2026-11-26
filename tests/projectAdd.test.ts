import test from "node:test";
import assert from "node:assert/strict";

import { loadDatabase, newProjectProblem } from "../src/core/reports";

const DB = loadDatabase(`
lost:
  - lost
gym:
  - gym
  - workout
`);

test("a new project whose name is taken is refused in plain words", () => {
  assert.equal(newProjectProblem(DB, "gym", ["fitness"]), "A project named gym already exists");
});

test("a new keyword already used by another project names that project", () => {
  assert.equal(newProjectProblem(DB, "fitness", ["Workout"]), "Keyword Workout is already used by gym");
});

test("a new project with free names and keywords is accepted", () => {
  assert.equal(newProjectProblem(DB, "reading", ["book"]), null);
});
