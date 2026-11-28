import test from "node:test";
import assert from "node:assert/strict";

import { addProjectText } from "../src/core/projectsText";
import { categoryForNew, loadDatabase, newProjectProblem } from "../src/core/reports";

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

test("a new project takes its nearest parent's category, and an existing one is inherited too", () => {
  const db = loadDatabase("kitchen:\n  category: personal\n  keywords: [kitchen]\nkitchen:orca:\n  keywords: [orca]\nwork:\n  category: professional\n  keywords: [work]\n");

  assert.equal(db.get("kitchen:orca")?.category, "personal");
  assert.equal(categoryForNew(db, "kitchen:orca:x"), "personal");
  assert.equal(categoryForNew(db, "work:api"), "professional");
  assert.equal(categoryForNew(db, "other:thing"), null);
});

test("addProjectText writes the inherited category", () => {
  const text = "kitchen:\n  category: personal\n  keywords: [kitchen]\n";
  const added = addProjectText(text, "kitchen:wine", undefined, "projects.yml");

  assert.match(added.text, /kitchen:wine:\n {2}category: personal\n/);
  assert.equal(added.project.category, "personal");
  assert.doesNotMatch(addProjectText(text, "gym", undefined, "projects.yml").text, /gym:\n {2}category/);
});

test("a project can be added with a chosen category, which wins over its parent's", () => {
  const text = "translation:\n  category: personal\n  keywords: [translation]\n";
  const added = addProjectText(text, "translation:okafor", undefined, "projects.yml", "professional");

  assert.equal(added.project.category, "professional");
  assert.equal(addProjectText(text, "translation:other", undefined, "projects.yml").project.category, "personal");
});
