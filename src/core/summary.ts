// Pure logic for the day viewer: parsing, grouping, and timeline layout. No DOM access.

export interface Reference {
  start: string;
  line: number;
}

export interface Entry {
  line: number;
  source: string;
  start: string;
  end: string | null;
  start_type: "absolute" | "relative";
  time_expression: string;
  duration_minutes: number | null;
  description: string;
  project: string;
  reference: Reference | null;
}

export interface TimeEntryDay {
  date: string;
  parsed_at: string;
  original_text: string;
  parser_version: string;
  tag: string | null;
  entries: Entry[];
  schema: string;
}

export interface Totals {
  minutes: number;
  open: number;
  count: number;
}

export interface ProjectGroup extends Totals {
  project: string;
  entries: Entry[];
}

export interface Axis {
  startMinute: number;
  endMinute: number;
}

export interface Segment {
  entry: Entry;
  left: number; // percent of the axis
  width: number; // percent of the axis
  open: boolean;
}

export const UNKNOWN_PROJECT = "unknown";
export const UNKNOWN_COLOR = "#8a8f98";
export const PALETTE = [
  "#4f8cf0",
  "#f0744f",
  "#3bb273",
  "#e5a50a",
  "#9b59d0",
  "#e84d8a",
  "#17a2b8",
  "#7f8c2a",
  "#d35400",
  "#2c7fb8",
  "#8e44ad",
  "#16a085",
];
// An open entry (no end time) is drawn this long, so it is visible on the timeline.
export const OPEN_ENTRY_MINUTES = 60;

const TIME_RE = /^(\d{2}):(\d{2})$/;

export function validate(value: unknown): TimeEntryDay {
  if (typeof value !== "object" || value === null) {
    throw new Error("Not a time-entry file: expected a JSON object");
  }
  const doc = value as Partial<TimeEntryDay>;
  if (!Array.isArray(doc.entries)) {
    throw new Error('Not a time-entry file: expected an "entries" array');
  }
  doc.entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || typeof (entry as Entry).start !== "string") {
      throw new Error(`Entry ${index + 1} has no start time`);
    }
  });
  return doc as TimeEntryDay;
}

export function toMinutes(time: string): number {
  const match = TIME_RE.exec(time);
  if (!match) {
    throw new Error(`Invalid time ${JSON.stringify(time)}`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "open";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export function totals(entries: readonly Entry[]): Totals {
  let minutes = 0;
  let open = 0;
  for (const entry of entries) {
    if (entry.duration_minutes === null) {
      open += 1;
    } else {
      minutes += entry.duration_minutes;
    }
  }
  return { minutes, open, count: entries.length };
}

// More tracked time comes first, and "unknown" always comes last.
export function groupByProject(entries: readonly Entry[]): ProjectGroup[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.project) ?? [];
    list.push(entry);
    groups.set(entry.project, list);
  }
  return [...groups.entries()]
    .map(([project, items]) => ({ project, entries: items, ...totals(items) }))
    .sort((a, b) => {
      if (a.project === UNKNOWN_PROJECT) return 1;
      if (b.project === UNKNOWN_PROJECT) return -1;
      return b.minutes - a.minutes || a.project.localeCompare(b.project);
    });
}

// Each project gets a colour from the palette by its position in the sorted list of
// project names. The same set of projects always gets the same colours.
export function projectColors(entries: readonly Entry[]): Map<string, string> {
  return colorsForProjects(entries.map((entry) => entry.project));
}

export function colorsForProjects(projects: readonly string[]): Map<string, string> {
  const names = [...new Set(projects)].filter((name) => name !== UNKNOWN_PROJECT).sort();
  const colors = new Map<string, string>();
  names.forEach((name, index) => colors.set(name, PALETTE[index % PALETTE.length]));
  colors.set(UNKNOWN_PROJECT, UNKNOWN_COLOR);
  return colors;
}

// An entry that passes midnight ends on the next day, so its end is worked out from its duration.
function entryEndMinutes(entry: Entry): number {
  if (entry.end !== null && entry.duration_minutes !== null) return toMinutes(entry.start) + entry.duration_minutes;
  if (entry.end !== null) return toMinutes(entry.end);
  return toMinutes(entry.start) + OPEN_ENTRY_MINUTES;
}

// Whole hours around the day: from the hour of the first start to the hour after the last end.
export function axisFor(entries: readonly Entry[]): Axis {
  if (entries.length === 0) {
    return { startMinute: 8 * 60, endMinute: 18 * 60 };
  }
  const starts = entries.map((entry) => toMinutes(entry.start));
  const ends = entries.map(entryEndMinutes);
  const startMinute = Math.floor(Math.min(...starts) / 60) * 60;
  let endMinute = Math.ceil(Math.max(...ends) / 60) * 60;
  if (endMinute <= startMinute) endMinute = startMinute + 60;
  return { startMinute, endMinute };
}

export function segmentsFor(entries: readonly Entry[], axis: Axis): Segment[] {
  const span = axis.endMinute - axis.startMinute;
  return entries.map((entry) => {
    const start = toMinutes(entry.start);
    const end = entryEndMinutes(entry);
    return {
      entry,
      left: ((start - axis.startMinute) / span) * 100,
      width: Math.max(((end - start) / span) * 100, 0),
      open: entry.end === null,
    };
  });
}

// Hour labels on the axis: every hour, or every two hours when the day is long.
export function hourTicks(axis: Axis): { minute: number; left: number; label: string }[] {
  const span = axis.endMinute - axis.startMinute;
  const step = span > 12 * 60 ? 120 : 60;
  const ticks = [];
  for (let minute = axis.startMinute; minute <= axis.endMinute; minute += step) {
    const hours = String(Math.floor(minute / 60) % 24).padStart(2, "0");
    ticks.push({ minute, left: ((minute - axis.startMinute) / span) * 100, label: `${hours}:00` });
  }
  return ticks;
}

// The share of a total as a whole percentage, for display: 1:03 of 2:03 is 51%. A share above zero
// that rounds to 0% shows as "<1%", so a tiny project is not shown as nothing.
export function formatShare(minutes: number, total: number): string {
  if (total <= 0 || minutes <= 0) return "0%";
  const percent = Math.round((minutes / total) * 100);
  return percent === 0 ? "<1%" : `${percent}%`;
}

export const PROJECT_SEPARATOR = ":";

// A project named a:b:c sits under a:b, which sits under a. Each node's totals include everything
// below it, so a parent row is the subtotal of its sub-projects and its own entries.
export interface ProjectNode extends Totals {
  path: string; // the full name, such as a:b
  label: string; // the last part of the name, such as b
  depth: number; // 0 for a top-level project
  children: ProjectNode[]; // sub-projects, most time first
  own: Entry[]; // the entries whose project is exactly this path
}

// Top-level projects, most time first, with "unknown" last. Every prefix of a project's name is a node,
// even when it is not a project of its own (a:b when only a:b:c exists).
export function projectTree(entries: readonly Entry[]): ProjectNode[] {
  const nodes = new Map<string, ProjectNode>();
  const nodeFor = (path: string): ProjectNode => {
    let node = nodes.get(path);
    if (!node) {
      const parts = path.split(PROJECT_SEPARATOR);
      node = {
        path,
        label: parts[parts.length - 1],
        depth: parts.length - 1,
        minutes: 0,
        count: 0,
        open: 0,
        children: [],
        own: [],
      };
      nodes.set(path, node);
    }
    return node;
  };

  for (const entry of entries) {
    const parts = entry.project.split(PROJECT_SEPARATOR);
    for (let size = parts.length; size >= 1; size--) {
      const node = nodeFor(parts.slice(0, size).join(PROJECT_SEPARATOR));
      node.count += 1;
      if (entry.duration_minutes === null) node.open += 1;
      else node.minutes += entry.duration_minutes;
    }
    nodeFor(entry.project).own.push(entry);
  }

  const top: ProjectNode[] = [];
  for (const node of nodes.values()) {
    if (node.depth === 0) {
      top.push(node);
    } else {
      nodes.get(node.path.slice(0, node.path.lastIndexOf(PROJECT_SEPARATOR)))?.children.push(node);
    }
  }
  const sortNodes = (list: ProjectNode[]): ProjectNode[] =>
    list.sort((a, b) => {
      if (a.path === UNKNOWN_PROJECT) return 1;
      if (b.path === UNKNOWN_PROJECT) return -1;
      return b.minutes - a.minutes || a.label.localeCompare(b.label);
    });
  for (const node of nodes.values()) sortNodes(node.children);
  return sortNodes(top);
}

// The entries of one project grouped by their description, most time first.
export interface TaskGroup extends Totals {
  description: string; // "(no description)" when the entry has none
}

export function tasksOf(entries: readonly Entry[]): TaskGroup[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const description = entry.description.trim() || "(no description)";
    const list = groups.get(description) ?? [];
    list.push(entry);
    groups.set(description, list);
  }
  return [...groups.entries()]
    .map(([description, items]) => ({ description, ...totals(items) }))
    .sort((a, b) => b.minutes - a.minutes || a.description.localeCompare(b.description));
}
