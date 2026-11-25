// Parses one day of time entries written as a task list (or an HTML page of list items).
//
// Times
//   Absolute: H, HH, HMM, HHMM or H:MM / HH:MM (24 hours). Minutes 00 and a leading zero are optional.
//   Relative: -d is d before the next absolute entry; +d is d after the previous entry's start.
//             d is minutes when it is a bare number (-30), or hours and minutes (-1:30 is 90).
//
// References
//   A description that is only a time refers to the nearest earlier entry starting at that time,
//   and takes that entry's description.
//
// Projects
//   A project is the one whose keyword appears in the description, as a whole word, ignoring case.
//   A keyword belongs to one project only. No keyword gives "unknown".
import { TimeParseError } from "./errors";
import { HEADER_RE } from "./header";
import { htmlToMarkdown, looksLikeHtml } from "./html";
import { PARSER_VERSION, SCHEMA_REFERENCE } from "./version";
import { UNKNOWN_PROJECT } from "./summary";
import { Projects, parseDescription } from "./description";

export { detectProject, parseDescription } from "./description";
export type { Projects, DescriptionParts } from "./description";

export { TimeParseError } from "./errors";
export { SCHEMA_REFERENCE, SCHEMA_VERSION, PARSER_VERSION } from "./version";

export const MINUTES_PER_DAY = 24 * 60;
// An entry may pass midnight only when the entry before it starts after this clock time.
export const MIDNIGHT_CUTOFF = 21 * 60;

// A header is the date, DD/MM or DD/MM/YYYY, optionally with a tag before it and text after it:
// "11/11", "#toggl 11/11", "toggl 11/11", "# Toggl 6/5 Partial". The tag may be written with or without "#".
const TASK_RE = /^[-*]\s*(?:\[[ xX]\]\s*)?(.*)$/;
const CLOCK_RE = /^(?:(\d{1,2}):(\d{2})|(\d{1,2})(\d{2})?)$/;
const DURATION_RE = /^(?:(\d+):(\d{2})|(\d+))$/;


export interface ParseOptions {
  projects?: Record<string, unknown>;
  defaultYear?: number;
  now?: Date;
  parsedAt?: string; // overrides the time written in the output; for reproducible output
}

export interface Reference {
  start: string;
  line: number;
}

export interface ParsedEntry {
  line: number;
  source: string;
  start: string;
  end: string | null;
  start_type: "absolute" | "relative";
  time_expression: string;
  duration_minutes: number | null;
  description: string;
  task: string;
  project: string;
  reference: Reference | null;
}

export interface ParsedDay {
  date: string;
  parsed_at: string;
  original_text: string;
  parser_version: string;
  tag: string | null;
  entries: ParsedEntry[];
  schema: string;
}

interface Draft {
  line: number;
  source: string;
  timeExpression: string;
  sign: "" | "+" | "-";
  minutes: number;
  referenceMinutes: number | null;
  text: string;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

// The local time with its offset, e.g. 2026-11-11T12:00:00+04:00 (ISO 8601).
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const magnitude = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`
  );
}

// Minutes of the day as HH:MM. Negative values keep their sign on the hours.
export function formatMinutes24(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${pad(hours)}:${pad(minutes - hours * 60)}`;
}

// Checks a name-to-keywords mapping and returns it with each keyword as a trimmed string.
export function validateProjects(projects: Record<string, unknown>): Projects {
  const normalised: Projects = new Map();
  const ownerOf = new Map<string, string>();
  for (const [name, value] of Object.entries(projects)) {
    if (!name.trim()) throw new TimeParseError("project name must be a non-empty string; quote it in YAML");
    if (name === UNKNOWN_PROJECT) throw new TimeParseError(`"${UNKNOWN_PROJECT}" is reserved for entries without a project`);
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || !list.every((word) => typeof word === "string")) {
      throw new TimeParseError(`project '${name}': keywords must be a list of strings`);
    }
    const words: string[] = [];
    for (const raw of list as string[]) {
      const text = raw.trim();
      if (!text) throw new TimeParseError(`project '${name}': keywords must not be blank`);
      const folded = text.toLowerCase();
      const owner = ownerOf.get(folded);
      if (owner !== undefined) {
        if (owner === name) throw new TimeParseError(`project '${name}': keyword '${text}' is listed twice`);
        throw new TimeParseError(`keyword '${text}' maps to both '${owner}' and '${name}'`);
      }
      ownerOf.set(folded, name);
      words.push(text);
    }
    normalised.set(name, words);
  }
  return normalised;
}

export function matchesPrefix(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix}:`);
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseHeader(text: string, defaultYear: number): [string | null, string] {
  const lines = text
    .split("\n")
    .map((line, index) => ({ number: index + 1, text: line.trim() }))
    .filter((line) => line.text !== "");
  if (!lines.length) {
    throw new TimeParseError("input is empty; expected a header such as '11/11' or '#toggl 11/11'");
  }
  const { number, text: line } = lines[0];
  const match = HEADER_RE.exec(line);
  if (!match) {
    throw new TimeParseError(`line ${number}: expected a header such as '11/11' or '#toggl 11/11', got '${line}'`);
  }
  const year = match[4] ? Number(match[4]) : defaultYear;
  const month = Number(match[3]);
  const day = Number(match[2]);
  if (!isValidDate(year, month, day)) throw new TimeParseError(`line ${number}: invalid date`);
  return [match[1] ?? null, `${pad(year, 4)}-${pad(month)}-${pad(day)}`];
}

// [clock hours, minutes] for H, HH, HMM, HHMM or H:MM, or null.
function splitClock(token: string): [number, number] | null {
  const match = CLOCK_RE.exec(token);
  if (!match) return null;
  if (match[1] !== undefined) return [Number(match[1]), Number(match[2])];
  return [Number(match[3]), Number(match[4] ?? 0)];
}

// Minutes for a relative offset: N is minutes, H:MM is hours and minutes.
function parseDuration(token: string): number | null {
  const match = DURATION_RE.exec(token);
  if (!match) return null;
  if (match[3] !== undefined) return Number(match[3]);
  if (Number(match[2]) >= 60) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseBody(number: number, source: string, body: string): Draft {
  const space = body.search(/\s/);
  const first = space === -1 ? body : body.slice(0, space);
  const rest = space === -1 ? "" : body.slice(space).trim();

  let sign: "" | "+" | "-" = "";
  let minutes: number;
  if (first[0] === "+" || first[0] === "-") {
    sign = first[0];
    const duration = parseDuration(first.slice(1));
    if (duration === null) throw new TimeParseError(`line ${number}: invalid relative time '${first}'`);
    minutes = duration;
  } else {
    const clock = splitClock(first);
    if (!clock) throw new TimeParseError(`line ${number}: invalid time '${first}'`);
    const [hours, mins] = clock;
    if (mins >= 60) throw new TimeParseError(`line ${number}: invalid time '${first}': minutes must be below 60`);
    if (hours >= 24) throw new TimeParseError(`line ${number}: invalid time '${first}': hours must be below 24`);
    minutes = hours * 60 + mins;
  }

  let referenceMinutes: number | null = null;
  let text = rest;
  const reference = rest ? splitClock(rest) : null;
  if (reference) {
    const [hours, mins] = reference;
    if (mins >= 60 || hours >= 24) throw new TimeParseError(`line ${number}: invalid reference time '${rest}'`);
    referenceMinutes = hours * 60 + mins;
    text = "";
  }
  return { line: number, source, timeExpression: first, sign, minutes, referenceMinutes, text };
}

function parseTasks(text: string): Draft[] {
  const drafts: Draft[] = [];
  let headerSeen = false;
  text.split("\n").forEach((raw, index) => {
    const number = index + 1;
    const line = raw.trim();
    if (!line) return;
    if (!headerSeen) {
      headerSeen = true;
      return;
    }
    if (HEADER_RE.test(line)) throw new TimeParseError(`line ${number}: only one day per input is supported`);
    const match = TASK_RE.exec(line);
    if (!match) {
      throw new TimeParseError(`line ${number}: expected a task such as '- [ ] 859 watch tv', got '${line}'`);
    }
    const body = match[1].trim();
    if (!body) return; // an empty placeholder
    drafts.push(parseBody(number, line, body));
  });
  if (!headerSeen) throw new TimeParseError("missing header such as '11/11' or '#toggl 11/11'");
  if (!drafts.length) throw new TimeParseError("no time entries found");
  return drafts;
}

function resolveStarts(drafts: Draft[]): number[] {
  const starts: (number | null)[] = drafts.map((draft) => (draft.sign ? null : draft.minutes));

  // "-d" starts d before the next entry starts. Consecutive "-d" entries are chained backwards from
  // the absolute entry that ends the run: the last one is resolved first, then the one before it, and so on.
  for (let index = drafts.length - 1; index >= 0; index--) {
    const draft = drafts[index];
    if (draft.sign !== "-") continue;
    const next = index + 1 < drafts.length ? starts[index + 1] : null;
    if (next === null) {
      throw new TimeParseError(`line ${draft.line}: relative time '${draft.timeExpression}' needs a following absolute time`);
    }
    starts[index] = next - draft.minutes;
  }

  drafts.forEach((draft, index) => {
    if (draft.sign !== "+") return;
    let anchor: number | null = null;
    for (let previous = index - 1; previous >= 0; previous--) {
      if (starts[previous] !== null) {
        anchor = starts[previous];
        break;
      }
    }
    if (anchor === null) {
      throw new TimeParseError(`line ${draft.line}: relative time '${draft.timeExpression}' needs a preceding entry`);
    }
    starts[index] = anchor + draft.minutes;
  });

  // The timeline: minutes from the start of the day. A new entry may start earlier on the clock
  // only when the previous one passes midnight, so the clock goes back once and the timeline
  // carries on into the next day. A second passage in the same file is an error.
  const timeline: number[] = [];
  let offset = 0;
  drafts.forEach((draft, index) => {
    const start = starts[index] as number;
    if (start < 0 || start >= MINUTES_PER_DAY) {
      throw new TimeParseError(`line ${draft.line}: time ${formatMinutes24(start)} is outside the day`);
    }
    const last = timeline[timeline.length - 1];
    if (last !== undefined && start + offset < last) {
      const previous = formatMinutes24(last % MINUTES_PER_DAY);
      if (offset > 0) {
        throw new TimeParseError(
          `line ${draft.line}: entry starts at ${formatMinutes24(start)}, before the previous entry at ${previous}; ` +
            "only one entry may pass midnight in a day",
        );
      }
      if (last % MINUTES_PER_DAY <= MIDNIGHT_CUTOFF) {
        throw new TimeParseError(
          `line ${draft.line}: entry starts at ${formatMinutes24(start)}, before the previous entry at ${previous}; ` +
            "an entry may pass midnight only when the entry before it starts after 21:00",
        );
      }
      offset = MINUTES_PER_DAY;
    }
    timeline.push(start + offset);
  });
  return timeline;
}

// starts: the timeline from resolveStarts. A reference compares clock times, so 8 is 08:00 on either side of midnight.
function resolveReferences(drafts: Draft[], timeline: number[]): { descriptions: string[]; references: (Reference | null)[] } {
  const descriptions: string[] = [];
  const references: (Reference | null)[] = [];
  drafts.forEach((draft, index) => {
    if (draft.referenceMinutes === null) {
      descriptions.push(draft.text);
      references.push(null);
      return;
    }
    let target = -1;
    for (let earlier = index - 1; earlier >= 0; earlier--) {
      if (timeline[earlier] % MINUTES_PER_DAY === draft.referenceMinutes) {
        target = earlier;
        break;
      }
    }
    if (target === -1) {
      throw new TimeParseError(
        `line ${draft.line}: reference ${formatMinutes24(draft.referenceMinutes)} does not match the start of an earlier entry`,
      );
    }
    descriptions.push(descriptions[target]);
    references.push({ start: formatMinutes24(timeline[target] % MINUTES_PER_DAY), line: drafts[target].line });
  });
  return { descriptions, references };
}

export function parseDay(text: string, options: ParseOptions = {}): ParsedDay {
  const now = options.now ?? new Date();
  const projects = validateProjects(options.projects ?? {});
  // HTML pages become task lines first, keeping the line numbers.
  const body = looksLikeHtml(text) ? htmlToMarkdown(text) : text;
  const [tag, date] = parseHeader(body, options.defaultYear ?? now.getFullYear());
  const drafts = parseTasks(body);
  const timeline = resolveStarts(drafts);
  const { descriptions, references } = resolveReferences(drafts, timeline);

  const entries: ParsedEntry[] = drafts.map((draft, index) => {
    const start = timeline[index];
    const end = index + 1 < drafts.length ? timeline[index + 1] : null;
    let parts: ReturnType<typeof parseDescription>;
    try {
      parts = parseDescription(descriptions[index], projects);
    } catch (err) {
      if (err instanceof TimeParseError) throw new TimeParseError(`line ${draft.line}: ${err.message}`);
      throw err;
    }
    return {
      line: draft.line,
      source: draft.source,
      start: formatMinutes24(start % MINUTES_PER_DAY),
      end: end === null ? null : formatMinutes24(end % MINUTES_PER_DAY),
      start_type: draft.sign ? "relative" : "absolute",
      time_expression: draft.timeExpression,
      duration_minutes: end === null ? null : end - start,
      description: descriptions[index],
      task: parts.task,
      project: parts.project,
      reference: references[index],
    };
  });

  return {
    date,
    parsed_at: options.parsedAt ?? isoWithOffset(now),
    original_text: text,
    parser_version: PARSER_VERSION,
    tag,
    entries,
    schema: SCHEMA_REFERENCE,
  };
}
