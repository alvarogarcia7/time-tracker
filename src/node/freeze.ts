// Files for frozen day files: the snapshots of the project database, freezing and unfreezing day files,
// and the reparse check. The rules are in src/core/freeze.ts. Snapshots are never changed or deleted here.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { parseDay } from "../core/parser";
import { looksLikeHtml } from "../core/html";
import {
  diffDays,
  findFrozenLine,
  snapshotIsCurrent,
  snapshotName,
  withFrozenLine,
  withoutFrozenLine,
} from "../core/freeze";
import { keywordsOf, loadDatabase } from "../core/reports";
import { convertText } from "./batch";

// A day's JSON as the comparison sees it: its entries and its other fields.
type DayRecord = { entries: { line?: unknown; [key: string]: unknown }[]; [key: string]: unknown };

const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}\.yml$/;
const DAY_FILE_RE = /\.(md|html)$/i;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// The snapshots sit next to the project database: data/projects.yml -> data/projects-snapshots.
export function snapshotsDirFor(projectsPath: string): string {
  return join(dirname(projectsPath), "projects-snapshots");
}

// The names of the snapshots in a folder, oldest first (the names sort by time).
export function listSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SNAPSHOT_RE.test(name))
    .map((name) => name.slice(0, -".yml".length))
    .sort();
}

// The text of a snapshot. A missing one is an error that names the snapshot and its file.
export function readSnapshot(dir: string | undefined, name: string): string {
  if (!dir) throw new Error(`frozen with projects=${name}: needs the project database (--projects) to find the snapshot`);
  const path = join(dir, `${name}.yml`);
  if (!existsSync(path)) throw new Error(`snapshot ${name} is missing (${path})`);
  return readFileSync(path, "utf-8");
}

function writeAtomic(path: string, text: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(temporary, text, "utf-8");
  renameSync(temporary, path);
}

// The snapshot for the current projects.yml text. A new one is written only when the newest snapshot
// has a different sha256; otherwise the newest is reused.
export function takeSnapshot(projectsText: string, dir: string, now: Date): { name: string; created: boolean } {
  const names = listSnapshots(dir);
  const newest = names.length ? names[names.length - 1] : null;
  const newestSha = newest === null ? null : sha256Text(readSnapshot(dir, newest));
  if (newest !== null && snapshotIsCurrent(newestSha, sha256Text(projectsText))) {
    return { name: newest, created: false };
  }
  const name = snapshotName(now);
  const path = join(dir, `${name}.yml`);
  if (existsSync(path)) throw new Error(`${path} already exists; try again in a second`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, projectsText, { encoding: "utf-8", flag: "wx" });
  return { name, created: true };
}

export interface FreezeOptions {
  projectsPath: string; // the project database; a missing file counts as no projects
  now?: Date;
  unfreeze?: boolean;
}

export interface FreezeOutcome {
  file: string;
  changed: boolean;
  snapshot?: string;
  snapshotCreated?: boolean;
}

// Freezes one day file (or removes its freeze line with unfreeze). The file must parse with the current
// projects, and its year is the year it already has when frozen, else the year of the clock.
export function freezeFile(file: string, options: FreezeOptions): FreezeOutcome {
  const text = readFileSync(file, "utf-8");
  if (options.unfreeze) {
    const next = withoutFrozenLine(text);
    if (next !== text) writeAtomic(file, next);
    return { file, changed: next !== text };
  }
  const now = options.now ?? new Date();
  const projectsText = existsSync(options.projectsPath) ? readFileSync(options.projectsPath, "utf-8") : "";
  const existing = findFrozenLine(text)?.mark ?? null;
  const year = existing?.year ?? now.getFullYear();
  // Parsing with the current projects checks the file before anything is written.
  const projects = Object.fromEntries(keywordsOf(loadDatabase(projectsText, options.projectsPath)));
  parseDay(text, { projects, defaultYear: year, now });

  const snapshot = takeSnapshot(projectsText, snapshotsDirFor(options.projectsPath), now);
  const next = withFrozenLine(text, { year, projects: snapshot.name }, looksLikeHtml(text));
  if (next !== text) writeAtomic(file, next);
  return { file, changed: next !== text, snapshot: snapshot.name, snapshotCreated: snapshot.created };
}

// The day files of a folder whose header date is from..to (both inclusive, YYYY-MM-DD).
export function dayFilesInRange(dataDir: string, from: string, to: string): { file: string; date?: string; error?: string }[] {
  const out: { file: string; date?: string; error?: string }[] = [];
  const files = readdirSync(dataDir).filter((name) => DAY_FILE_RE.test(name)).sort();
  for (const name of files) {
    const file = join(dataDir, name);
    try {
      const date = parseDay(readFileSync(file, "utf-8"), { defaultYear: new Date().getFullYear() }).date;
      if (date >= from && date <= to) out.push({ file, date });
    } catch (err) {
      out.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export interface ReparseEntry {
  file: string;
  status: "same" | "changed" | "no-json" | "snapshot-mismatch" | "error";
  lines: string[];
}

// Parses every frozen day file in a folder again with the current parser and compares it with its JSON
// in the same folder. A snapshot whose sha256 no longer matches the JSON's projects_sha256 is flagged.
export function reparseCheck(dataDir: string, projectsPath: string): ReparseEntry[] {
  const snapshots = snapshotsDirFor(projectsPath);
  const out: ReparseEntry[] = [];
  for (const name of readdirSync(dataDir).filter((n) => DAY_FILE_RE.test(n)).sort()) {
    const file = join(dataDir, name);
    const text = readFileSync(file, "utf-8");
    const mark = findFrozenLine(text)?.mark ?? null;
    if (!mark) continue;

    const jsonPath = join(dataDir, `${basename(name, extname(name))}.json`);
    if (!existsSync(jsonPath)) {
      out.push({ file, status: "no-json", lines: ["no JSON to compare with"] });
      continue;
    }
    try {
      const old = JSON.parse(readFileSync(jsonPath, "utf-8")) as DayRecord;
      const fresh = convertText(text, { snapshotsDir: snapshots }) as DayRecord;
      const lines = diffDays(old, fresh);
      const current = sha256Text(readSnapshot(snapshots, mark.projects));
      let status: ReparseEntry["status"] = lines.length ? "changed" : "same";
      if (old.projects_sha256 !== current) {
        status = "snapshot-mismatch";
        lines.unshift(`snapshot ${mark.projects} no longer matches the projects_sha256 in the JSON`);
      }
      out.push({ file, status, lines });
    } catch (err) {
      out.push({ file, status: "error", lines: [err instanceof Error ? err.message : String(err)] });
    }
  }
  return out;
}
