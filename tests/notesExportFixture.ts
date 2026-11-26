// A small Notes Exporter folder for the notes-import script: a tracker file and one Markdown file per note.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureNote {
  noteNo: string;
  subdir: string;
  folderPath?: string[];
}

export const FIXTURE_TEXT = "5/11\n- [ ] 0900 gym\n";

export function filenameOf(note: FixtureNote): string {
  return `toggl-${note.noteNo}`;
}

// Writes the tracker and the Markdown of each note; text is the Markdown every note gets.
export function exportFolder(root: string, notes: FixtureNote[], text = FIXTURE_TEXT): void {
  const tracker: Record<string, unknown> = {};
  for (const note of notes) {
    tracker[note.noteNo] = {
      id: `x-coredata://store/ICNote/p${note.noteNo}`,
      title: `Toggl ${note.noteNo}`,
      filename: filenameOf(note),
      subdir: note.subdir,
      folderPath: note.folderPath ?? note.subdir.split("-"),
      createdAt: "2026-11-05T09:00:00+04:00",
    };
    writeSource(root, note, text);
  }
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "tracker.json"), JSON.stringify(tracker));
}

// Replaces the Markdown of one note in the export, as a change in Apple Notes does.
export function writeSource(root: string, note: FixtureNote, text: string): void {
  mkdirSync(join(root, "md", note.subdir), { recursive: true });
  writeFileSync(join(root, "md", note.subdir, `${filenameOf(note)}.md`), text);
}

// Runs the notes-import script with these arguments and returns its output.
export function runNotesImport(...args: string[]): string {
  return execFileSync(process.execPath, [join(process.cwd(), "scripts", "notes-import.mjs"), ...args], { encoding: "utf8" });
}
