import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportFolder, FixtureNote, runNotesImport, writeSource } from "./notesExportFixture";

// Importing the same Apple Notes note again: the ledger in data/in decides, see docs/notes-import.md.

const NOTE: FixtureNote = { noteNo: "1", subdir: "iCloud-Work" };
const V1 = "5/11\n- [ ] 0900 gym\n";
const V2 = "5/11\n- [ ] 0900 gym\n- [ ] 1000 review\n";

interface Setup {
  dir: string;
  root: string;
  importRoot: string;
  ledger: string;
  cleanup(): void;
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "tp-notes-repeat-"));
  const root = join(dir, "export");
  const importRoot = join(dir, "data", "in");
  exportFolder(root, [NOTE], V1);
  return { dir, root, importRoot, ledger: join(importRoot, "imports.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// One select run; each run writes its own folder, as make notes-select does.
function selectInto(s: Setup, stamp: string): { out: string; selection: any; output: string } {
  const out = join(s.importRoot, stamp);
  const output = runNotesImport("select", "--root", s.root, "--out", out);
  return { out, selection: JSON.parse(readFileSync(join(out, "selection.json"), "utf8")), output };
}

const localCopy = (s: Setup, stamp: string) => join(s.importRoot, stamp, "toggl-1.md");

test("a note that did not change in Apple Notes is not copied again", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    const second = selectInto(s, "run2");

    assert.equal(second.selection.notes.length, 0);
    assert.equal(second.selection.unchanged.length, 1);
    assert.equal(existsSync(localCopy(s, "run2")), false);
    assert.match(second.output, /1 unchanged/);
  } finally {
    s.cleanup();
  }
});

test("a note changed in Apple Notes, with no local edit, is imported again and the ledger points at the new copy", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    writeSource(s.root, NOTE, V2);
    const second = selectInto(s, "run2");

    assert.deepEqual(second.selection.notes.map((n: { status: string }) => n.status), ["updated"]);
    assert.equal(readFileSync(localCopy(s, "run2"), "utf8"), V2);
    const ledger = JSON.parse(readFileSync(s.ledger, "utf8"));
    const entry = Object.values(ledger.notes)[0] as { file: string; replaces: string };
    assert.equal(entry.file, "run2/toggl-1.md");
    assert.equal(second.selection.notes[0].replaces, "run1/toggl-1.md");
  } finally {
    s.cleanup();
  }
});

test("a local edit is kept when Apple Notes changes, and the Apple version waits in incoming/", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    const edited = "5/11\n- [ ] 0900 gym, fixed by hand\n";
    writeFileSync(localCopy(s, "run1"), edited);
    writeSource(s.root, NOTE, V2);
    const second = selectInto(s, "run2");

    assert.equal(second.selection.conflicts.length, 1);
    assert.equal(existsSync(localCopy(s, "run2")), false, "nothing is copied over the edit");
    assert.equal(readFileSync(localCopy(s, "run1"), "utf8"), edited, "the local copy is untouched");
    assert.equal(readFileSync(join(s.importRoot, "run2", "incoming", "toggl-1.md"), "utf8"), V2);
    runNotesImport("review", "--out", second.out);
    const report = readFileSync(join(second.out, "REPORT.txt"), "utf8");
    assert.match(report, /make notes-keep-local FILE=.*run1\/toggl-1\.md/);
    assert.match(report, /make notes-take-incoming FILE=.*run1\/toggl-1\.md/);
    // The original stays in Apple Notes' export until the conflict is decided.
    const deleteScript = readFileSync(join(second.out, "delete.sh"), "utf8");
    assert.equal(deleteScript.includes("toggl-1.md"), false);
  } finally {
    s.cleanup();
  }
});

test("keep-local accepts the local copy: the Apple version is then no longer a change", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    writeFileSync(localCopy(s, "run1"), "5/11\n- [ ] 0900 gym, kept\n");
    writeSource(s.root, NOTE, V2);
    selectInto(s, "run2");

    runNotesImport("keep-local", "--ledger", s.ledger, "--file", localCopy(s, "run1"));
    const third = selectInto(s, "run3");

    assert.equal(third.selection.conflicts.length, 0);
    assert.equal(third.selection.unchanged.length, 1);
    assert.equal(existsSync(join(s.importRoot, "run2", "incoming", "toggl-1.md")), false);
    assert.equal(readFileSync(localCopy(s, "run1"), "utf8"), "5/11\n- [ ] 0900 gym, kept\n");
  } finally {
    s.cleanup();
  }
});

test("take-incoming replaces the local copy and keeps the edited one in replaced/", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    const edited = "5/11\n- [ ] 0900 gym, fixed by hand\n";
    writeFileSync(localCopy(s, "run1"), edited);
    writeSource(s.root, NOTE, V2);
    selectInto(s, "run2");

    runNotesImport("take-incoming", "--ledger", s.ledger, "--file", localCopy(s, "run1"));

    assert.equal(readFileSync(localCopy(s, "run1"), "utf8"), V2);
    assert.equal(readFileSync(join(s.importRoot, "run1", "replaced", "toggl-1.md"), "utf8"), edited);
    const third = selectInto(s, "run3");
    assert.equal(third.selection.unchanged.length, 1, "the replaced version is now the imported one");
  } finally {
    s.cleanup();
  }
});

test("a deleted local copy is imported again", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    rmSync(localCopy(s, "run1"));
    const second = selectInto(s, "run2");

    assert.deepEqual(second.selection.notes.map((n: { status: string }) => n.status), ["new"]);
    assert.equal(readFileSync(localCopy(s, "run2"), "utf8"), V1);
  } finally {
    s.cleanup();
  }
});

test("a file that is not an imported copy cannot be decided", () => {
  const s = setup();
  try {
    selectInto(s, "run1");
    assert.throws(() => runNotesImport("keep-local", "--ledger", s.ledger, "--file", join(s.dir, "other.md")), /not an imported copy/);
  } finally {
    s.cleanup();
  }
});
