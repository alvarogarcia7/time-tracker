// Rules of the mobile editor, without any DOM: adding and removing entries in the day text, and the short
// labels the phone shows. The text stays the only source of truth, as in editorModel.ts.
import { buildLine, classify, headerIndex } from "./editorModel";

const PLACEHOLDER_RE = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?$/;

// An empty entry line such as "- [ ] ", which a new day starts with.
export function isPlaceholder(line: string): boolean {
  return PLACEHOLDER_RE.test(line);
}

// The text with a new entry. After the line at `after` when given (a line of an entry), otherwise at the end
// of the entries: an empty placeholder line there is filled instead of keeping an empty entry above the new one.
// Returns the lines and the index of the new entry.
export function addEntry(
  lines: readonly string[],
  time: string,
  description: string,
  after?: number,
): { lines: string[]; index: number } {
  const updated = [...lines];
  if (after !== undefined) {
    const current = classify(lines[after]);
    const prefix = current.kind === "task" ? current.prefix : "- [ ] ";
    updated.splice(after + 1, 0, buildLine(prefix, time, description));
    return { lines: updated, index: after + 1 };
  }
  let last = updated.length - 1;
  while (last >= 0 && updated[last].trim() === "") last--;
  if (last >= 0 && isPlaceholder(updated[last])) {
    const prefix = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?/.exec(updated[last])?.[0] ?? "- [ ] ";
    updated[last] = buildLine(prefix, time, description);
    return { lines: updated, index: last };
  }
  const at = Math.max(last, headerIndex(updated)) + 1;
  updated.splice(at, 0, buildLine("- [ ] ", time, description));
  return { lines: updated, index: at };
}

// The value of a time input for a token or a start: "0806" and "08:06" give "08:06"; anything else gives "".
export function clockOfToken(token: string): string {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(token.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

// A length of time for a card: "25m", "1h", "1h 25m". Null when the entry is open.
export function durationLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

// The projects of the entries most often used in a day, most minutes first, at most `count`.
// An entry without a project does not count. Ties go by name.
export function frequentProjects(entries: readonly { project: string; duration_minutes: number | null }[], unknown: string, count: number): string[] {
  const minutes = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.project || entry.project === unknown) continue;
    minutes.set(entry.project, (minutes.get(entry.project) ?? 0) + (entry.duration_minutes ?? 0) + 1);
  }
  return [...minutes.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([name]) => name);
}

// The names that match what is typed: the typed words all appear in the name (ignoring case), names that
// start with the text first. At most `count`.
export function matchingProjects(names: readonly string[], typed: string, count: number): string[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const found = names.filter((name) => words.every((word) => name.toLowerCase().includes(word)));
  const text = typed.trim().toLowerCase();
  found.sort((a, b) => Number(b.toLowerCase().startsWith(text)) - Number(a.toLowerCase().startsWith(text)) || (a < b ? -1 : a > b ? 1 : 0));
  return found.slice(0, count);
}

// Whether the line is a reference to another entry: its description is only the time of that entry, such as
// "806". The parser then gives the entry the other one's description, which cannot be edited on this line.
export function isReferenceLine(description: string, parsedDescription: string): boolean {
  return description.trim() !== "" && description.trim() !== parsedDescription.trim();
}

// The start time as the day files write it, from what a person types: "08:30", "8:30", "830", "7.15" and
// "07.15" are clock times; "+10", "-5" and "-1:10" are minutes after the previous entry ends or before the next
// one starts. Null for anything else, such as "quarter past nine".
export function normalizeStart(typed: string): string | null {
  const text = typed.trim();
  const clock = /^(\d{1,2})[:.](\d{2})$/.exec(text) ?? /^(\d{1,2})(\d{2})$/.exec(text);
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${clock[2]}`;
  }
  return /^[+-]\d{1,3}(?::[0-5]\d)?$/.test(text) ? text : null;
}

export const START_HELP = "Use a time like 08:30, 830 or 7.15, or +10 / -5 for minutes after the previous entry or before the next.";
