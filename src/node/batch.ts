// Converts every day file in a folder to parser output JSON, named after the input.
// A file that fails is reported; the others are still converted.
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { parseDay } from "../core/parser";

export const DEFAULT_PATTERNS = ["*.md", "*.html"];

export interface ConvertOptions {
  patterns?: string[];
  projects?: Record<string, string[]>;
  defaultYear?: number;
  now?: Date;
}

export interface ConvertResult {
  written: string[];
  failed: { file: string; message: string }[];
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

  const result: ConvertResult = { written: [], failed: [] };
  for (const source of sources) {
    let day;
    try {
      day = parseDay(readFileSync(source, "utf-8"), {
        projects: options.projects,
        defaultYear: options.defaultYear,
        now: options.now,
      });
    } catch (err) {
      result.failed.push({ file: source, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const target = join(outDir, `${basename(source, extname(source))}.json`);
    writeFileSync(target, JSON.stringify(day, null, 2) + "\n", "utf-8");
    result.written.push(target);
  }
  return result;
}
