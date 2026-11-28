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

// What the project views need from an entry: its project and its time (null while it is open). An Entry
// has both; a report record has them under its own names.
export interface ProjectTime {
  project: string;
  duration_minutes: number | null;
}

export interface ProjectGroup<T extends ProjectTime = Entry> extends Totals {
  project: string;
  entries: T[];
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

export function totals(entries: readonly ProjectTime[]): Totals {
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
export function groupByProject<T extends ProjectTime>(entries: readonly T[]): ProjectGroup<T>[] {
  const groups = new Map<string, T[]>();
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

// A project and every project above it: a:b:c gives a, a:b and a:b:c. A parent that has no entries of its own
// still needs a colour for the sunburst and the breakdown.
export function withPrefixes(projects: readonly string[]): string[] {
  const names = new Set<string>();
  for (const project of projects) {
    const parts = project.split(PROJECT_SEPARATOR);
    for (let size = 1; size <= parts.length; size++) names.add(parts.slice(0, size).join(PROJECT_SEPARATOR));
  }
  return [...names];
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
export interface ProjectNode<T extends ProjectTime = Entry> extends Totals {
  path: string; // the full name, such as a:b
  label: string; // the last part of the name, such as b
  depth: number; // 0 for a top-level project
  children: ProjectNode<T>[]; // sub-projects, most time first
  own: T[]; // the entries whose project is exactly this path
}

// Top-level projects, most time first, with "unknown" last. Every prefix of a project's name is a node,
// even when it is not a project of its own (a:b when only a:b:c exists).
export function projectTree<T extends ProjectTime>(entries: readonly T[]): ProjectNode<T>[] {
  const nodes = new Map<string, ProjectNode<T>>();
  const nodeFor = (path: string): ProjectNode<T> => {
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

  const top: ProjectNode<T>[] = [];
  for (const node of nodes.values()) {
    if (node.depth === 0) {
      top.push(node);
    } else {
      nodes.get(node.path.slice(0, node.path.lastIndexOf(PROJECT_SEPARATOR)))?.children.push(node);
    }
  }
  const sortNodes = (list: ProjectNode<T>[]): ProjectNode<T>[] =>
    list.sort((a, b) => {
      if (a.path === UNKNOWN_PROJECT) return 1;
      if (b.path === UNKNOWN_PROJECT) return -1;
      return b.minutes - a.minutes || a.label.localeCompare(b.label);
    });
  for (const node of nodes.values()) sortNodes(node.children);
  return sortNodes(top);
}

// What the breakdown and tasks need from an entry: its project, its time and its description.
export interface TaskItem extends ProjectTime {
  description: string;
}

// The entries of one project grouped by their description, most time first.
export interface TaskGroup extends Totals {
  description: string; // "(no description)" when the entry has none
}

export function tasksOf(entries: readonly TaskItem[]): TaskGroup[] {
  const groups = new Map<string, TaskItem[]>();
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

// The project and task breakdown as rows, in the order they are shown: each project, then (when it is
// expanded) its sub-projects, then its own tasks. A project row's minutes include everything below it.
// A task row's depth is one more than the project that owns it.
export type BreakdownRow =
  | { kind: "project"; path: string; label: string; depth: number; minutes: number; expandable: boolean; open: boolean }
  | { kind: "task"; depth: number; task: TaskGroup };

export function breakdownRows(nodes: readonly ProjectNode<TaskItem>[], expanded: ReadonlySet<string>): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  const visit = (list: readonly ProjectNode<TaskItem>[], depth: number): void => {
    for (const node of list) {
      const expandable = node.children.length > 0 || node.own.length > 0;
      const open = expandable && expanded.has(node.path);
      rows.push({ kind: "project", path: node.path, label: node.label, depth, minutes: node.minutes, expandable, open });
      if (open) {
        visit(node.children, depth + 1);
        for (const task of tasksOf(node.own)) rows.push({ kind: "task", depth: depth + 1, task });
      }
    }
  };
  visit(nodes, 0);
  return rows;
}

// The sunburst: the top-level projects form the inner ring, and each sub-project sits in the next ring,
// inside the arc of its parent. Angles are in radians, clockwise from twelve o'clock. One minute is the
// same angle at every depth, so a child's arc is its minutes, and the time of a parent that no child
// covers is the rest of the parent's arc.
export const FULL_CIRCLE = 2 * Math.PI;

export interface SunburstArc {
  path: string;
  label: string;
  depth: number;
  minutes: number;
  start: number;
  end: number;
}

export function sunburstArcs(nodes: readonly ProjectNode<TaskItem>[]): SunburstArc[] {
  const total = nodes.reduce((sum, node) => sum + node.minutes, 0);
  const radiansPerMinute = total > 0 ? FULL_CIRCLE / total : 0;
  const arcs: SunburstArc[] = [];
  const place = (list: readonly ProjectNode<TaskItem>[], start: number, depth: number): void => {
    let cursor = start;
    for (const node of list) {
      if (node.minutes <= 0) continue; // nothing tracked: no arc, and nothing below it either
      const end = cursor + node.minutes * radiansPerMinute;
      arcs.push({ path: node.path, label: node.label, depth, minutes: node.minutes, start: cursor, end });
      place(node.children, cursor, depth + 1);
      cursor = end;
    }
  };
  place(nodes, 0, 0);
  return arcs;
}

export interface SunburstGeometry {
  radius: number; // the outer radius of the whole chart
  hole: number; // the empty centre, where the total is shown
}

export interface SunburstSlice extends SunburstArc {
  inner: number;
  outer: number;
  d: string; // the SVG path of the slice
}

// Each ring has the same depth: the radius between the hole and the outer edge is split by the number of levels.
export function sunburstSlices(nodes: readonly ProjectNode<TaskItem>[], geometry: SunburstGeometry): SunburstSlice[] {
  const arcs = sunburstArcs(nodes);
  const levels = arcs.reduce((deepest, arc) => Math.max(deepest, arc.depth + 1), 0);
  const ring = levels ? (geometry.radius - geometry.hole) / levels : 0;
  return arcs.map((arc) => {
    const inner = geometry.hole + arc.depth * ring;
    const outer = inner + ring;
    return { ...arc, inner, outer, d: annularSectorPath(geometry.radius, geometry.radius, inner, outer, arc.start, arc.end) };
  });
}

// The SVG path of a ring sector, centred on (cx, cy). A sector of a whole circle is drawn as two halves,
// since an arc from a point back to the same point draws nothing.
export function annularSectorPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  if (end - start >= FULL_CIRCLE - EPSILON_ANGLE) {
    const middle = start + FULL_CIRCLE / 2;
    return annularSectorPath(cx, cy, inner, outer, start, middle) + annularSectorPath(cx, cy, inner, outer, middle, start + FULL_CIRCLE);
  }
  const point = (radius: number, angle: number): string =>
    `${formatCoordinate(cx + radius * Math.sin(angle))} ${formatCoordinate(cy - radius * Math.cos(angle))}`;
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M ${point(outer, start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)}`,
    `L ${point(inner, end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)}`,
    "Z",
  ].join(" ");
}

// Zooming into a project: the slices drawn when the chart is zoomed into `zoomed`. Its children (every slice below
// it) fill the whole circle, the innermost of them on the first ring, and the rings are spaced again over the same
// radius. With no zoom, or a project with nothing below it or not in the chart, the slices are returned unchanged.
export function sunburstZoom(slices: readonly SunburstSlice[], zoomed: string | null, geometry: SunburstGeometry): SunburstSlice[] {
  const zoom = zoomed === null ? undefined : slices.find((slice) => slice.path === zoomed);
  const below = zoom ? slices.filter((slice) => slice.path.startsWith(`${zoom.path}:`)) : [];
  const depthOffset = zoom ? zoom.depth + 1 : 0;
  const top = below.filter((slice) => slice.depth === depthOffset);
  if (!zoom || !top.length) return [...slices];
  const origin = Math.min(...top.map((slice) => slice.start));
  const scale = FULL_CIRCLE / (Math.max(...top.map((slice) => slice.end)) - origin);
  const levels = below.reduce((deepest, slice) => Math.max(deepest, slice.depth - depthOffset + 1), 0);
  const ring = (geometry.radius - geometry.hole) / levels;
  return below.map((slice) => {
    const depth = slice.depth - depthOffset;
    const start = (slice.start - origin) * scale;
    const end = (slice.end - origin) * scale;
    const inner = geometry.hole + depth * ring;
    const outer = inner + ring;
    return { ...slice, depth, start, end, inner, outer, d: annularSectorPath(geometry.radius, geometry.radius, inner, outer, start, end) };
  });
}

// Whether a project can be zoomed into: a slice sits below it. A project with no time, or none below it, has no children.
export function sunburstHasChildren(slices: readonly SunburstSlice[], path: string): boolean {
  return slices.some((slice) => slice.path.startsWith(`${path}:`));
}

// The project one level up from `path`, or null for a top-level project (the way back to the whole chart).
export function sunburstParent(path: string): string | null {
  return path.includes(":") ? path.slice(0, path.lastIndexOf(":")) : null;
}

// The centre of the sunburst: the overall total when not zoomed, or the subtotal of the zoomed project (its own time
// and everything below it, as its arc) with its name. A zoom onto a project not in the chart is the same as no zoom.
export interface SunburstCentre {
  name: string;
  minutes: number;
}

export function sunburstCentre(slices: readonly SunburstSlice[], zoomed: string | null, total: number): SunburstCentre {
  const zoom = zoomed === null ? undefined : slices.find((slice) => slice.path === zoomed);
  return zoom ? { name: zoom.path, minutes: zoom.minutes } : { name: "All", minutes: total };
}

// The label drawn on a slice, or null when not even a short one fits. The label is the last part of the name. It fits
// when its estimated width (the average character is LABEL_CHAR_WIDTH of the font size) is no more than the smaller of
// the slice's arc at the middle of its ring and the ring's thickness. Otherwise it is cut to the characters that fit,
// with an ellipsis, and left out when fewer than two characters fit. The full name stays in the hover.
export const LABEL_CHAR_WIDTH = 0.6;

export function sunburstVisibleLabel(slice: SunburstSlice, fontSize: number): string | null {
  const available = Math.min((slice.end - slice.start) * ((slice.inner + slice.outer) / 2), slice.outer - slice.inner);
  const charWidth = fontSize * LABEL_CHAR_WIDTH;
  if (slice.label.length * charWidth <= available) return slice.label;
  const count = Math.floor(available / charWidth) - 1; // the ellipsis takes one character's width
  if (count < 2) return null;
  return `${slice.label.slice(0, count)}…`;
}

const EPSILON_ANGLE = 1e-9;

function formatCoordinate(value: number): string {
  return (Math.abs(value) < 0.0005 ? 0 : value).toFixed(3);
}
