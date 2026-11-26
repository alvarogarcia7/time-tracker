// The export bundle and the import plan: nothing is overwritten silently.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { BUNDLE_FORMAT, importCopyName, makeBundle, parseBundle, planImport } from "../src/core/bundle";

const NOW = new Date(2026, 10, 25, 10, 15, 0);
const DAY = { name: "2026-11-25.md", text: "25/11/2026\n- [ ] 0900 gym\n", updated: "2026-11-25T09:00:00.000Z" };
const PROJECTS = { name: "projects.yml", text: "gym: [gym]\n", updated: "2026-11-25T09:00:00.000Z" };

describe("export bundle", () => {
  test("a bundle round-trips through its text", () => {
    const bundle = makeBundle([DAY], PROJECTS, new Date("2026-11-25T10:00:00.000Z"));
    const again = parseBundle(JSON.stringify(bundle));
    assert.equal(again.format, BUNDLE_FORMAT);
    assert.deepEqual(again.days, [DAY]);
    assert.deepEqual(again.projects, PROJECTS);
  });

  test("a projects entry that is not projects.yml is refused, so no database copy is planned", () => {
    const bundle = {
      format: BUNDLE_FORMAT,
      version: 1,
      exported: NOW.toISOString(),
      days: [],
      projects: { name: "notes.txt", text: "gym: [gym]\n", updated: NOW.toISOString() },
      projectCopies: [],
    };
    assert.throws(() => parseBundle(JSON.stringify(bundle)), /not the project database \(projects\.yml\)/);
  });

  test("a database copy with a folder part or the database's own name is refused", () => {
    for (const name of ["../projects.conflict-x.yml", "sub/projects.conflict-x.yml", "projects.yml", "notes.txt"]) {
      const bundle = { format: BUNDLE_FORMAT, version: 1, exported: NOW.toISOString(), days: [], projects: null, projectCopies: [{ name, text: "", updated: NOW.toISOString() }] };
      assert.throws(() => parseBundle(JSON.stringify(bundle)), /not a project database name/, name);
    }
  });

  test("a file that is not an export is refused with the reason", () => {
    assert.throws(() => parseBundle("not json"), /not JSON/);
    assert.throws(() => parseBundle('{"format":"other"}'), /not a time-parser export/);
    assert.throws(
      () => parseBundle(JSON.stringify({ format: BUNDLE_FORMAT, version: 1, days: [{ name: "../x.md", text: "", updated: "" }] })),
      /not a day file name/,
    );
  });
});

describe("import plan", () => {
  test("new files are added, identical ones are skipped", () => {
    const bundle = parseBundle(JSON.stringify(makeBundle([DAY], PROJECTS, NOW)));
    const plan = planImport(bundle, new Map([[DAY.name, DAY.text]]), new Map([[PROJECTS.name, PROJECTS.text]]), NOW);
    assert.deepEqual(plan, [
      { kind: "same", target: "day", name: DAY.name },
      { kind: "same", target: "database", name: "projects.yml" },
    ]);
    const empty = planImport(bundle, new Map(), new Map(), NOW);
    assert.deepEqual(
      empty.map((action) => action.kind),
      ["add", "add"],
    );
  });

  test("a file that differs is kept, and the imported text is added as a copy", () => {
    const bundle = parseBundle(JSON.stringify(makeBundle([DAY], PROJECTS, NOW)));
    const plan = planImport(
      bundle,
      new Map([[DAY.name, "25/11/2026\n- [ ] 0800 other\n"]]),
      new Map([[PROJECTS.name, "lost: [lost]\n"]]),
      NOW,
    );
    assert.deepEqual(plan[0], {
      kind: "conflict",
      target: "day",
      name: "2026-11-25.md",
      copy: "2026-11-25.conflict-20261125-101500.md",
      text: DAY.text,
    });
    assert.deepEqual(plan[1], {
      kind: "conflict",
      target: "database",
      name: "projects.yml",
      copy: "projects.conflict-20261125-101500.yml",
      text: PROJECTS.text,
    });
  });

  test("a conflict copy of the project database is part of the export and comes back on import", () => {
    const copy = { name: "projects.conflict-20261125-101500.yml", text: "lost: [lost]\n", updated: NOW.toISOString() };
    const exported = makeBundle([DAY], PROJECTS, NOW, [copy]);
    const again = parseBundle(JSON.stringify(exported));
    assert.deepEqual(again.projectCopies, [copy]);
    const plan = planImport(again, new Map(), new Map(), NOW);
    assert.deepEqual(
      plan.filter((action) => action.target === "database").map((action) => [action.kind, action.name]),
      [
        ["add", "projects.yml"],
        ["add", "projects.conflict-20261125-101500.yml"],
      ],
    );
  });

  test("a copy in an import that differs from this device's copy is kept as a copy again", () => {
    const copy = { name: "projects.conflict-20261125-101500.yml", text: "gym: [gym]\n", updated: NOW.toISOString() };
    const bundle = parseBundle(JSON.stringify(makeBundle([], null, NOW, [copy])));
    const plan = planImport(bundle, new Map(), new Map([[copy.name, "lost: [lost]\n"]]), NOW);
    assert.equal(plan[0].kind, "conflict");
    if (plan[0].kind !== "conflict") throw new Error("unreachable");
    assert.equal(plan[0].target, "database");
    assert.notEqual(plan[0].copy, copy.name);
    assert.match(plan[0].copy, /\.conflict-.*\.yml$/);
  });

  test("copy names do not collide with files already there", () => {
    const taken = new Set(["x.conflict-20261125-101500.md"]);
    assert.equal(importCopyName("x.md", NOW, (name) => taken.has(name)), "x.conflict-20261125-101500-2.md");
  });
});
