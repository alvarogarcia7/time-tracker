import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportFolder, FixtureNote, runNotesImport } from "./notesExportFixture";

// The notes-select step of scripts/notes-import.mjs, run on a small Notes Exporter folder.

// Runs select with the extra arguments; returns the notes selected and the folders left out, as noteNo lists.
function select(notes: FixtureNote[], ...extra: string[]): { selected: string[]; skipped: string[]; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "tp-notes-select-"));
  try {
    const root = join(dir, "export");
    exportFolder(root, notes);
    const out = join(dir, "in", "2026-11-05-09_00_00");
    const output = runNotesImport("select", "--root", root, "--out", out, ...extra);
    const selection = JSON.parse(readFileSync(join(out, "selection.json"), "utf8"));
    return {
      selected: selection.notes.map((note: { noteNo: string }) => note.noteNo),
      skipped: selection.skipped.map((note: { noteNo: string }) => note.noteNo),
      output,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOTES: FixtureNote[] = [
  { noteNo: "1", subdir: "iCloud-Work" },
  { noteNo: "2", subdir: "iCloud-Work-Projects" },
  { noteNo: "3", subdir: "iCloud-Home" },
  { noteNo: "4", subdir: "iCloud-Recently-Deleted" },
];

test("the Recently Deleted folder is left out by default, and said so", () => {
  const result = select(NOTES);

  assert.deepEqual(result.selected, ["1", "2", "3"]);
  assert.deepEqual(result.skipped, ["4"]);
  assert.match(result.output, /Left out 1 Toggl notes in excluded folders: iCloud-Recently-Deleted \(1\)/);
});

test("--include takes a folder back from the default exclusion", () => {
  const result = select(NOTES, "--include", "iCloud-Recently-Deleted");

  assert.deepEqual(result.selected, ["1", "2", "3", "4"]);
  assert.deepEqual(result.skipped, []);
});

test("--exclude leaves out a folder and its subfolders", () => {
  const folders: FixtureNote[] = [
    { noteNo: "1", subdir: "Work", folderPath: ["Work"] },
    { noteNo: "2", subdir: "Work/Projects", folderPath: ["Work", "Projects"] },
    { noteNo: "3", subdir: "Home", folderPath: ["Home"] },
  ];
  const result = select(folders, "--exclude", "Work");

  assert.deepEqual(result.selected, ["3"]);
  assert.deepEqual(result.skipped, ["1", "2"]);
});

test("--include on its own leaves every folder selected", () => {
  const folders: FixtureNote[] = [
    { noteNo: "1", subdir: "Work", folderPath: ["Work"] },
    { noteNo: "2", subdir: "Home", folderPath: ["Home"] },
  ];
  const result = select(folders, "--include", "Work");

  assert.deepEqual(result.selected, ["1", "2"]);
  assert.deepEqual(result.skipped, []);
});

test("the most specific folder rule wins: a subfolder can be included inside an excluded folder", () => {
  const folders: FixtureNote[] = [
    { noteNo: "1", subdir: "Work/Projects", folderPath: ["Work", "Projects"] },
    { noteNo: "2", subdir: "Work/Old", folderPath: ["Work", "Old"] },
    { noteNo: "3", subdir: "Home", folderPath: ["Home"] },
  ];
  const result = select(folders, "--exclude", "Work", "--include", "Work/Projects");

  assert.deepEqual(result.selected, ["1", "3"]);
  assert.deepEqual(result.skipped, ["2"]);
});

test("a folder rule with no name is rejected", () => {
  assert.throws(() => select(NOTES, "--exclude", "/"), /needs a folder name/);
});
