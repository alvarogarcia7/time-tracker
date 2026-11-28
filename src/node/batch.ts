// Converts every day file in a folder to parser output JSON, named after the input.
// A file that fails is reported; the others are still converted. A file whose JSON was made from the
// same inputs, parser and year is skipped, unless force is set.
//
// A live file (no freeze line) is parsed with the projects it is given and the year from the options
// or the clock. A frozen file (see freeze.ts) is parsed with the projects of its snapshot and the year
// of its freeze line, so it gives the same output whatever the clock and projects.yml say now.
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { PARSER_VERSION } from "../core/version";
import { parseDay } from "../core/parser";
import { findFrozenLine, FrozenMark, ConvertKey, shouldSkipConvert } from "../core/freeze";
import { keywordsOf, loadDatabase } from "../core/reports";
import { readSnapshot, sha256Text } from "./freeze";

export const DEFAULT_PATTERNS = ["*.md", "*.html"];

export interface ConvertOptions {
  patterns?: string[];
  projects?: Record<string, string[]>; // the live projects, parsed from projectsText
  projectsText?: string; // the text of projects.yml, recorded in the JSON
  snapshotsDir?: string; // where the snapshots of frozen files are (data/projects-snapshots)
  defaultYear?: number;
  now?: Date;
  force?: boolean; // parse every file again
}

export interface ConvertResult {
  written: string[];
  skipped: string[];
  failed: { file: string; message: string }[];
}

// What a parse of one file depends on, worked out before the parse so an unchanged file is not parsed.
export interface DayPlan {
  key: ConvertKey;
  projectsText: string;
  projects: Record<string, string[]> | undefined;
  source: string; // projects.yml, or the snapshot name
  frozen: FrozenMark | null;
}

export function planDay(text: string, options: ConvertOptions): DayPlan {
  const frozen = findFrozenLine(text)?.mark ?? null;
  const projectsText = frozen ? readSnapshot(options.snapshotsDir, frozen.projects) : (options.projectsText ?? "");
  const projects = frozen
    ? Object.fromEntries(keywordsOf(loadDatabase(projectsText, frozen.projects)))
    : options.projects;
  const year = frozen?.year ?? options.defaultYear ?? (options.now ?? new Date()).getFullYear();
  return {
    key: {
      input_sha256: sha256Text(text),
      projects_sha256: sha256Text(projectsText),
      parser_version: PARSER_VERSION,
      year,
    },
    projectsText,
    projects,
    source: frozen ? frozen.projects : "projects.yml",
    frozen,
  };
}

// The JSON of one file: the parser output, with the inputs it was made from next to original_text.
export function buildDay(text: string, plan: DayPlan, now?: Date): Record<string, unknown> {
  const day = parseDay(text, { projects: plan.projects, defaultYear: plan.key.year, now });
  const extra = {
    projects_text: plan.projectsText,
    projects_source: plan.source,
    projects_sha256: plan.key.projects_sha256,
    input_sha256: plan.key.input_sha256,
    frozen: plan.frozen !== null,
    year: plan.key.year,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(day)) {
    out[key] = value;
    if (key === "original_text") Object.assign(out, extra);
  }
  return out;
}

// The previous JSON's inputs, for the skip test; null when there is no readable JSON.
function previousKey(path: string): ConvertKey | null {
  if (!existsSync(path)) return null;
  try {
    const old = JSON.parse(readFileSync(path, "utf-8"));
    return {
      input_sha256: old.input_sha256,
      projects_sha256: old.projects_sha256,
      parser_version: old.parser_version,
      year: old.year,
    };
  } catch {
    return null;
  }
}

export function convertFolder(inDir: string, outDir: string, options: ConvertOptions = {}): ConvertResult {
  if (!existsSync(inDir) || !statSync(inDir).isDirectory()) throw new Error(`${inDir}: not a folder`);
  mkdirSync(outDir, { recursive: true });

  const names = new Set<string>();
  for (const pattern of options.patterns ?? DEFAULT_PATTERNS) {
    for (const name of globSync(pattern, { cwd: inDir })) names.add(name);
  }
  const sources = [...names]
    .map((name) => join(inDir, name))
    .filter((path) => statSync(path).isFile())
    .sort();

  const result: ConvertResult = { written: [], skipped: [], failed: [] };
  for (const source of sources) {
    const target = join(outDir, `${basename(source, extname(source))}.json`);
    try {
      const text = readFileSync(source, "utf-8");
      const plan = planDay(text, options);
      if (shouldSkipConvert(previousKey(target), plan.key, options.force ?? false)) {
        result.skipped.push(target);
        continue;
      }
      const day = buildDay(text, plan, options.now);
      writeFileSync(target, JSON.stringify(day, null, 2) + "\n", "utf-8");
      result.written.push(target);
    } catch (err) {
      result.failed.push({ file: source, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

// Parses one text on its own (no file, no skip test): the same JSON convertFolder writes.
export function convertText(text: string, options: ConvertOptions = {}): Record<string, unknown> {
  return buildDay(text, planDay(text, options), options.now);
}
