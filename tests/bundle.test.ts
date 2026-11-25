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
    const plan = planImport(bundle, new Map([[DAY.name, DAY.text]]), PROJECTS.text, NOW);
    assert.deepEqual(plan, [
      { kind: "same", target: "day", name: DAY.name },
      { kind: "same", target: "database", name: "projects.yml" },
    ]);
    const empty = planImport(bundle, new Map(), null, NOW);
    assert.deepEqual(
      empty.map((action) => action.kind),
      ["add", "add"],
    );
  });

  test("a file that differs is kept, and the imported text is added as a copy", () => {
    const bundle = parseBundle(JSON.stringify(makeBundle([DAY], PROJECTS, NOW)));
    const plan = planImport(bundle, new Map([[DAY.name, "25/11/2026\n- [ ] 0800 other\n"]]), "lost: [lost]\n", NOW);
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

  test("copy names do not collide with files already there", () => {
    const taken = new Set(["x.conflict-20261125-101500.md"]);
    assert.equal(importCopyName("x.md", NOW, (name) => taken.has(name)), "x.conflict-20261125-101500-2.md");
  });
});
