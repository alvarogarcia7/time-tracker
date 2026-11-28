// Editing rules for the day files, without any DOM. The text is the only source of truth:
// every change rebuilds a line of text, and the entries view reads the text back.
import { Database, detectProjectInDb, keywordsOf } from "./reports";
import { ancestorsOf, parseDescription } from "./description";
import { UNKNOWN_PROJECT } from "./summary";

export interface TaskLine {
  kind: "task";
  prefix: string; // indentation, bullet and checkbox, e.g. "- [ ] "
  time: string; // first token, e.g. "8", "-1:10" or "" when missing
  description: string;
}

export interface OtherLine {
  kind: "other";
  text: string;
}

export type Line = TaskLine | OtherLine;

// Bullet and optional checkbox, then the rest. Checkbox states: [ ], [x], [X].
const TASK_RE = /^(\s*[-*]\s*(?:\[[ xX]\]\s*)?)(\S.*)$/;
const EMPTY_RE = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?$/;

export const RELATIVE_TIMES = ["-0:05", "-0:10", "-0:15", "-0:30", "-1:00", "+0:05", "+0:15", "+0:30", "+1:00"];

export function splitLines(text: string): string[] {
  return text.split("\n");
}

export function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

export function classify(line: string): Line {
  if (EMPTY_RE.test(line)) return { kind: "other", text: line }; // an empty placeholder such as "- [ ] "
  const match = TASK_RE.exec(line);
  if (!match) return { kind: "other", text: line };
  const [, prefix, body] = match;
  const space = body.search(/\s/);
  if (space === -1) return { kind: "task", prefix, time: body, description: "" };
  return { kind: "task", prefix, time: body.slice(0, space), description: body.slice(space).trim() };
}

export function buildLine(prefix: string, time: string, description: string): string {
  const head = prefix + time;
  if (!description) return head;
  return time ? `${head} ${description}` : `${head}${description}`;
}

export function setTask(lines: readonly string[], index: number, change: { time?: string; description?: string }): string[] {
  const current = classify(lines[index]);
  if (current.kind !== "task") throw new Error(`line ${index + 1} is not an entry`);
  const updated = [...lines];
  updated[index] = buildLine(
    current.prefix,
    change.time ?? current.time,
    change.description ?? current.description,
  );
  return updated;
}

export function setLine(lines: readonly string[], index: number, text: string): string[] {
  const updated = [...lines];
  updated[index] = text;
  return updated;
}

// A new entry after the given line, with the same prefix, the given time and no description.
export function insertAfter(lines: readonly string[], index: number, time: string): string[] {
  const current = classify(lines[index]);
  const prefix = current.kind === "task" ? current.prefix : "- [ ] ";
  const updated = [...lines];
  updated.splice(index + 1, 0, buildLine(prefix, time, ""));
  return updated;
}

// Enter in plain text: the new entry as insertAfter makes it, with a space after a time so that the
// caret, left at the end of the line, is set apart from the time and the typed text is not joined to it.
export function insertForTyping(lines: readonly string[], index: number, time: string): string[] {
  const updated = insertAfter(lines, index, time);
  if (time) updated[index + 1] += " ";
  return updated;
}

// The first words of the status line: "Unsaved changes", or "Saved" when the file is saved and parses.
// A saved file with a parse error gets no "Saved", so the status does not say it is fine.
export function statusLead(dirty: boolean, hasParseError: boolean): string[] {
  if (dirty) return ["Unsaved changes"];
  return hasParseError ? [] : ["Saved"];
}

// The status after a save: "Saved.", or a warning when the saved text does not parse, because Save works on
// any text and a file that does not parse shows no entries.
export function savedMessage(parse: { ok: boolean; error?: string }): { text: string; isError: boolean } {
  if (parse.ok) return { text: savedNotice, isError: false };
  return { text: `Saved, but the file does not parse: ${parse.error ?? "unknown error"}`, isError: true };
}

// The status message when a typed day-file name opens nothing: none when no name is typed or some file matches.
export function noDayFileNotice(typed: string, matchingFiles: number): string | null {
  const name = typed.trim();
  return name && matchingFiles === 0 ? `No day file named ${name}` : null;
}

// The file is unsaved when its text differs from the saved text, or a cell holds typed text not yet committed.
export function isUnsaved(text: string, saved: string, typedPending: boolean): boolean {
  return typedPending || text !== saved;
}

// The status line after a save. The backup of the old text is kept in the backup folder, which is not named here.
export const savedNotice = "Saved.";

// The visible label of the button that adds an entry after a row.
export const addEntryLabel = "Add entry after";

// Shown in an empty PROJECT cell, which otherwise looks like blank text.
export const PROJECT_PLACEHOLDER = "pick a project";

// The TIME cell of a valid row shows the start the parser found; a row without one keeps its typed token.
export function timeCellText(token: string, start: string | null): string {
  return start ?? token;
}

// The tooltip on the TIME header: what a relative token such as -30 means.
export const TIME_HEADER_HINT =
  "-30 means 30 minutes before the next absolute time.";

// The one question asked before a day file is deleted: it names the day file and its JSON (which may not exist).
export function deleteConfirmation(name: string, unsaved: boolean): string {
  const json = `${name.replace(/\.md$/, "")}.json`;
  return `Delete ${name} and ${json} (if there is one) from the folder? Both are kept as backups.${unsaved ? " The unsaved changes are lost too." : ""}`;
}

// The day file the editor shows after a delete: the next file in the list, else the previous one, else none.
export function nextDayAfter(names: string[], deleted: string): string | null {
  const index = names.indexOf(deleted);
  const rest = names.filter((name) => name !== deleted);
  if (index < 0) return rest[0] ?? null;
  return rest[index] ?? rest[index - 1] ?? null;
}

// The one question asked before Reload throws away the unsaved edits to the open day.
export function reloadPrompt(name: string): string {
  return `Reload ${name} and lose its unsaved changes?`;
}

// The status line after an edit moved the end of the entry on line: none when the end did not change.
export function endChangeNotice(line: number, before: string | null, after: string | null): string | null {
  if (before === after) return null;
  return after === null ? `Line ${line} is now open.` : `Line ${line} now ends at ${after}.`;
}

// The local time as HH:MM, from the browser's clock and time zone.
export function clockTime(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// The start time for an entry added after the line at index. After an entry that has an end, that end
// (the next entry starts there). After the last entry, which is open, the local time now. When the file
// does not parse, the entry is unknown: the time is the local time if no entry follows, and blank otherwise.
export function timeAfter(
  lines: readonly string[],
  index: number,
  parsed: { end: string | null } | undefined,
  now: Date,
): string {
  if (parsed) return parsed.end ?? clockTime(now);
  const later = lines.slice(index + 1).some((line) => classify(line).kind === "task");
  return later ? "" : clockTime(now);
}

export function removeLine(lines: readonly string[], index: number): string[] {
  if (classify(lines[index]).kind !== "task") throw new Error(`line ${index + 1} is not an entry`);
  return lines.filter((_, position) => position !== index);
}

// The index of the header: the first line that is not blank.
export function headerIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim() !== "");
}

export interface ProjectChange {
  description?: string;
  error?: string;
}

// The text with ", keyword" at its end. Trailing spaces and commas of the text are dropped first.
function joinTag(text: string, keyword: string): string {
  const base = text.replace(/[\s,]+$/, "");
  return base ? `${base}, ${keyword}` : keyword;
}

// Choosing a project writes one of its keywords as the comma tag at the end of the description, because
// the project comes from that tag (or from a keyword found in the text). The keyword must not hold a comma,
// which would split the tag. A description that already gives the project is unchanged. A comma tag that
// gives another project, or none, is replaced; any other description gets ", keyword" at its end.
export function withProject(description: string, project: string, db: Database): ProjectChange {
  if (!db.has(project)) return { error: `${project} is not in the project database; add it there first` };
  // A keyword without a comma. Its own keywords come first, then those of the projects above it:
  // car:maintainance has the keyword car of project car, which also matches it.
  const candidates = [project, ...ancestorsOf(project)].flatMap((name) => db.get(name)?.keywords ?? []);
  const keyword = candidates.find((word) => !word.includes(","));
  if (!keyword) return { error: `${project} has no keyword without ','; add one to the project database` };
  let current: ReturnType<typeof parseDescription>;
  try {
    current = parseDescription(description, keywordsOf(db));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (current.project === project) return { description };
  const next = current.form === "tag" && current.tagAt !== undefined
    ? joinTag(description.slice(0, current.tagAt), keyword)
    : joinTag(description, keyword);
  try {
    if (detectProjectInDb(next, db) !== project) {
      return { error: `the description would not give ${project}; edit it by hand` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { description: next };
}

// Checks a change to one line before it is applied: only the line at index may change, and on that line the
// description must give the project, as the parser will read it. Returns the reason, or null when it is right.
export function verifyProjectChange(
  before: readonly string[],
  after: readonly string[],
  index: number,
  project: string,
  db: Database,
): string | null {
  if (before.length !== after.length) return "the change would add or remove lines";
  const other = after.findIndex((line, position) => position !== index && line !== before[position]);
  if (other !== -1) return `the change would also change line ${other + 1}; nothing was changed`;
  const line = classify(after[index]);
  if (line.kind !== "task") return `line ${index + 1} is not an entry`;
  let shown: string;
  try {
    shown = detectProjectInDb(line.description, db);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (shown !== project) return `line ${index + 1} would show ${shown}, not ${project}; nothing was changed`;
  return null;
}

export type CategoryFilter = "all" | "categorized" | "uncategorized";
export type ProjectFilter = "all" | "with" | "without";

// An entry is categorized when its project has a category. An entry with no project is uncategorized.
export function matchesFilters(
  project: string,
  category: string | null,
  filters: { category: CategoryFilter; project: ProjectFilter },
): boolean {
  const hasProject = project !== "" && project !== UNKNOWN_PROJECT;
  if (filters.project === "with" && !hasProject) return false;
  if (filters.project === "without" && hasProject) return false;
  if (filters.category === "categorized" && category === null) return false;
  if (filters.category === "uncategorized" && category !== null) return false;
  return true;
}

export interface LineAnnotation {
  number: number; // 1-based line number
  project: string; // "" when the line is not an entry, or has no project
  error?: string; // set when the project cannot be picked (an ambiguous description)
}

// The project beside each line of the plain text view. It is the project the entries table shows for
// the same line: the description the parser gave a reference (such as "8"), otherwise the line's own
// description. The header and lines that are not entries get no project.
export function lineAnnotations(
  text: string,
  db: Database | null,
  entries: readonly { line: number; description: string }[] = [],
): LineAnnotation[] {
  const lines = splitLines(text);
  const header = headerIndex(lines);
  const described = new Map(entries.map((entry) => [entry.line, entry.description]));
  return lines.map((line, index) => {
    const annotation: LineAnnotation = { number: index + 1, project: "" };
    const parsed = classify(line);
    if (!db || index === header || parsed.kind !== "task") return annotation;
    try {
      const project = detectProjectInDb(described.get(index + 1) ?? parsed.description, db);
      annotation.project = project === UNKNOWN_PROJECT ? "" : project;
    } catch (err) {
      annotation.error = err instanceof Error ? err.message : String(err);
    }
    return annotation;
  });
}
