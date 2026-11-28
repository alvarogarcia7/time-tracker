// Pure helpers for frozen day files: the frozen line, snapshot names, the convert skip test and the
// reparse diff. No file access here; the Node side writes and reads the files.
//
// A frozen line is "# frozen: year=2026 projects=2026-11-26T10_21_02" (in an HTML page, the same inside
// an HTML comment). A snapshot is named after the local time it was taken.

export interface FrozenMark {
  year: number;
  projects: string; // the snapshot name, e.g. 2026-11-26T10_21_02
}

const FROZEN_RE = /^(?:#\s*frozen:|<!--\s*frozen:)\s*year=(\d{4})\s+projects=(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2})\s*(?:-->)?$/;

export function formatFrozenLine(mark: FrozenMark, html = false): string {
  const body = `frozen: year=${mark.year} projects=${mark.projects}`;
  return html ? `<!-- ${body} -->` : `# ${body}`;
}

// The mark on a line, or null when the line is not a frozen line.
export function parseFrozenLine(line: string): FrozenMark | null {
  const match = FROZEN_RE.exec(line.trim());
  if (!match) return null;
  return { year: Number(match[1]), projects: match[2] };
}

// The line of the text that holds the freeze mark, with its mark, or null.
export function findFrozenLine(text: string): { index: number; mark: FrozenMark } | null {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const mark = parseFrozenLine(lines[index]);
    if (mark) return { index, mark };
  }
  return null;
}

// Where a new frozen line goes: after the header (the first non-blank line) of a Markdown day, and in an
// HTML page just before the first list, since the header is the text above the list.
function insertionIndex(lines: string[], html: boolean): number {
  if (html) {
    const first = lines.findIndex((line) => /<(ul|ol|li)[\s>]/i.test(line));
    return first === -1 ? lines.length : first;
  }
  const header = lines.findIndex((line) => line.trim() !== "");
  return header === -1 ? 0 : header + 1;
}

// The text with its freeze line set: an existing line is replaced, otherwise the line goes after the header.
export function withFrozenLine(text: string, mark: FrozenMark, html: boolean): string {
  const line = formatFrozenLine(mark, html);
  const lines = text.split("\n");
  const found = findFrozenLine(text);
  if (found) lines[found.index] = line;
  else lines.splice(insertionIndex(lines, html), 0, line);
  return lines.join("\n");
}

// The text without its freeze line (unfreezing). Other lines are left as they are.
export function withoutFrozenLine(text: string): string {
  const lines = text.split("\n");
  const found = findFrozenLine(text);
  if (found) lines.splice(found.index, 1);
  return lines.join("\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

// The snapshot name for a local time: YYYY-MM-DDTHH_MM_SS (colons are not used in file names).
export function snapshotName(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`
  );
}

// Freezing reuses the newest snapshot when projects.yml has the same sha256 as it.
export function snapshotIsCurrent(newestSha: string | null, projectsSha: string): boolean {
  return newestSha !== null && newestSha === projectsSha;
}

export interface ConvertKey {
  input_sha256: string;
  projects_sha256: string;
  parser_version: string;
  year: number;
}

// convert skips a file when the JSON written last time was made from the same inputs, parser and year.
export function shouldSkipConvert(previous: ConvertKey | null, wanted: ConvertKey, force: boolean): boolean {
  if (force || previous === null) return false;
  return (
    previous.input_sha256 === wanted.input_sha256 &&
    previous.projects_sha256 === wanted.projects_sha256 &&
    previous.parser_version === wanted.parser_version &&
    previous.year === wanted.year
  );
}

interface EntryLike {
  line?: unknown;
  [key: string]: unknown;
}

interface DayLike {
  entries: EntryLike[];
  [key: string]: unknown;
}

const show = (value: unknown) => JSON.stringify(value);

// The differences between two parses of one file, as text lines. parsed_at is ignored.
export function diffDays(before: DayLike, after: DayLike): string[] {
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => key !== "parsed_at" && key !== "entries",
  );
  for (const key of keys) {
    if (show(before[key]) !== show(after[key])) out.push(`${key} ${show(before[key])} -> ${show(after[key])}`);
  }

  if (before.entries.length !== after.entries.length) {
    out.push(`entries: ${before.entries.length} -> ${after.entries.length} entries`);
  }
  const shared = Math.min(before.entries.length, after.entries.length);
  for (let index = 0; index < shared; index++) {
    const a = before.entries[index];
    const b = after.entries[index];
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const where = `entries[${index}] (line ${String(b.line ?? a.line)})`;
    for (const field of fields) {
      if (show(a[field]) !== show(b[field])) out.push(`${where}: ${field} ${show(a[field])} -> ${show(b[field])}`);
    }
  }
  return out;
}
