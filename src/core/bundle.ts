// The export bundle: every day file and the project database as one JSON document, and the plan for
// importing one. An import never overwrites a file whose text differs: the imported text is added as
// a copy with a .conflict-<stamp> suffix, and the copy is reported.
import { fileStamp } from "./hash";

export const BUNDLE_FORMAT = "time-parser-bundle";

export interface BundleFile {
  name: string;
  text: string;
  updated: string; // ISO time of the last change on the device that exported it
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  version: 1;
  exported: string;
  days: BundleFile[];
  projects: BundleFile | null;
}

export function makeBundle(days: BundleFile[], projects: BundleFile | null, exported: Date): Bundle {
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    exported: exported.toISOString(),
    days: [...days].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    projects,
  };
}

function isFileEntry(value: unknown): value is BundleFile {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === "string" && typeof entry.text === "string" && typeof entry.updated === "string";
}

// Checks the shape of a bundle; throws a message that names the problem.
export function parseBundle(text: string): Bundle {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the file is not JSON");
  }
  const bundle = value as Partial<Bundle>;
  if (typeof value !== "object" || value === null || bundle.format !== BUNDLE_FORMAT) {
    throw new Error("the file is not a time-parser export");
  }
  if (bundle.version !== 1) throw new Error(`unsupported export version ${String(bundle.version)}`);
  if (!Array.isArray(bundle.days) || !bundle.days.every(isFileEntry)) throw new Error("the days list is malformed");
  if (bundle.projects !== null && bundle.projects !== undefined && !isFileEntry(bundle.projects)) {
    throw new Error("the projects database is malformed");
  }
  for (const day of bundle.days) {
    if (!day.name.endsWith(".md") || day.name.includes("/")) throw new Error(`${day.name}: not a day file name`);
  }
  return { ...bundle, projects: bundle.projects ?? null } as Bundle;
}

export type ImportAction =
  | { kind: "add"; target: "day" | "database"; name: string; text: string }
  | { kind: "conflict"; target: "day" | "database"; name: string; copy: string; text: string }
  | { kind: "same"; target: "day" | "database"; name: string };

// The copy name: foo.md becomes foo.conflict-<stamp>.md, projects.yml becomes projects.conflict-<stamp>.yml.
export function importCopyName(name: string, now: Date, taken: (name: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const stamp = fileStamp(now);
  let candidate = `${base}.conflict-${stamp}${extension}`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${base}.conflict-${stamp}-${n}${extension}`;
  return candidate;
}

// Decides what to do with each file of the bundle, given the texts already on the device.
// localDays: name to text of the day files; localDatabase: the projects.yml text, when there is one.
export function planImport(
  bundle: Bundle,
  localDays: Map<string, string>,
  localDatabase: string | null,
  now: Date,
): ImportAction[] {
  const actions: ImportAction[] = [];
  const taken = new Set(localDays.keys());
  const place = (target: "day" | "database", name: string, text: string, existing: string | null) => {
    if (existing === null) {
      actions.push({ kind: "add", target, name, text });
    } else if (existing === text) {
      actions.push({ kind: "same", target, name });
    } else {
      const copy = importCopyName(name, now, (candidate) => taken.has(candidate));
      taken.add(copy);
      actions.push({ kind: "conflict", target, name, copy, text });
    }
  };
  for (const day of bundle.days) place("day", day.name, day.text, localDays.get(day.name) ?? null);
  if (bundle.projects) place("database", "projects.yml", bundle.projects.text, localDatabase);
  return actions;
}
