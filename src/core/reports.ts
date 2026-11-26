// Hours reports in TypeScript, matching time_parser/reports.py and projects_db.py. No DOM access.
import { parse as parseYaml } from "yaml";

import { TimeParseError, matchesPrefix, validateProjects } from "./parser";
import { parseDescription } from "./description";

import { Entry, TimeEntryDay, UNKNOWN_PROJECT, validate } from "./summary";

export const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;
export type Period = (typeof PERIODS)[number];
export const CATEGORIES = ["personal", "professional"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface DbProject {
  name: string;
  keywords: string[];
  category: Category | null;
}
export type Database = Map<string, DbProject>;

export interface EntryRecord {
  day: string; // ISO date, YYYY-MM-DD
  start: string;
  minutes: number | null; // null for an open entry
  description: string;
  project: string;
  category: Category | null;
}

export interface Filters {
  start?: string;
  end?: string;
  names?: string[];
  prefixes?: string[];
  category?: Category;
}

export interface PeriodRow {
  period: string;
  hours: number;
  entries: number;
  open_entries: number;
}

export interface ProjectRow {
  project: string;
  category: Category | null;
  hours: number;
  entries: number;
  open_entries: number;
  share_percent: number;
}

export interface Report {
  period: Period;
  from: string | null;
  to: string | null;
  projects: string[];
  prefixes: string[];
  category: Category | null;
  totals: { hours: number; entries: number; open_entries: number; days: number };
  by_period: PeriodRow[];
  by_project: ProjectRow[];
  skipped: string[];
}

const FIELDS = new Set(["keywords", "category"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message: string): never {
  throw new TimeParseError(message);
}

// ---- project database -------------------------------------------------------

// The project of a description, looked up in the database.
export function detectProjectInDb(description: string, db: Database): string {
  return parseDescription(description, keywordsOf(db)).project;
}

export function keywordsOf(db: Database): Map<string, string[]> {
  return new Map([...db.values()].map((project) => [project.name, project.keywords]));
}

// Reads the database: each project with its keywords and optional category.
// YAML 1.1 rules , so an unquoted "no" is a key of false and is refused.
export function loadDatabase(text: string, source = "projects.yml"): Database {
  let data: unknown;
  try {
    data = parseYaml(text, { version: "1.1", mapAsMap: true });
  } catch (err) {
    fail(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null || data === undefined) data = new Map();
  if (!(data instanceof Map)) fail(`${source}: expected a mapping of project name to settings`);

  const rawKeywords = new Map<string, unknown>();
  const categoryOf = new Map<string, Category | null>();
  for (const [name, value] of data as Map<unknown, unknown>) {
    if (typeof name !== "string" || name.trim() === "") {
      fail(`${source}: project name ${JSON.stringify(name)} must be a non-empty string; quote it in YAML`);
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const fields = [...(value as Map<unknown, unknown>).keys()].map(String);
      const unknown = fields.filter((field) => !FIELDS.has(field)).sort();
      if (unknown.length) fail(`${source}: project ${name}: unknown field ${unknown.join(", ")}`);
      const settings = value as Map<string, unknown>;
      const category = settings.get("category") ?? null;
      if (category !== null && !(CATEGORIES as readonly unknown[]).includes(category)) {
        fail(`${source}: project ${name}: category must be personal or professional, got ${JSON.stringify(category)}`);
      }
      rawKeywords.set(name, settings.get("keywords") ?? []);
      categoryOf.set(name, category as Category | null);
    } else {
      rawKeywords.set(name, value);
      categoryOf.set(name, null);
    }
  }

  let keywords: Map<string, string[]>;
  try {
    keywords = validateProjects(Object.fromEntries(rawKeywords));
  } catch (err) {
    fail(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const db: Database = new Map();
  for (const [name, words] of keywords) {
    db.set(name, { name, keywords: words, category: categoryOf.get(name) ?? null });
  }
  return db;
}

// Why a new project cannot be added to the database, in words for the form; null when it can.
// Keywords are compared without case, as the parser matches them.
export function newProjectProblem(db: Database, name: string, keywords: string[]): string | null {
  if (db.has(name)) return `A project named ${name} already exists`;
  for (const word of keywords) {
    const wanted = word.toLowerCase();
    for (const project of db.values()) {
      if (project.keywords.some((known) => known.toLowerCase() === wanted)) {
        return `Keyword ${word} is already used by ${project.name}`;
      }
    }
  }
  return null;
}

// ---- records ----------------------------------------------------------------

export interface LoadedDay {
  name: string;
  text: string;
}

// Each file is parsed and checked. Files that are not day outputs are skipped and listed.
export function recordsFromFiles(files: LoadedDay[], db: Database): { records: EntryRecord[]; skipped: string[] } {
  const records: EntryRecord[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    let doc: TimeEntryDay;
    try {
      const parsed: unknown = JSON.parse(file.text);
      if (typeof parsed !== "object" || parsed === null || !("date" in parsed)) {
        skipped.push(`${file.name}: not a time-entry file`);
        continue;
      }
      doc = validate(parsed);
    } catch {
      skipped.push(/\.md$/i.test(file.name) ? `${file.name}: Reports needs JSON` : `${file.name}: not JSON`);
      continue;
    }
    if (typeof doc.date !== "string" || !DAY_RE.test(doc.date)) {
      skipped.push(`${file.name}: bad date ${JSON.stringify(doc.date)}`);
      continue;
    }
    for (const entry of doc.entries as Entry[]) {
      let project: string;
      try {
        project = parseDescription(entry.description, keywordsOf(db)).project;
      } catch (err) {
        fail(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      records.push({
        day: doc.date,
        start: entry.start,
        minutes: entry.duration_minutes,
        description: entry.description,
        project,
        category: db.get(project)?.category ?? null,
      });
    }
  }
  return { records, skipped };
}

// ---- periods ----------------------------------------------------------------

function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  return formatDay(new Date(parseDay(day).getTime() + count * DAY_MS));
}

// ISO 8601 week number, weeks start on Monday.
function isoWeek(day: string): { year: number; week: number } {
  const date = parseDay(day);
  const dayNumber = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNumber + 3); // Thursday of this week
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year, week };
}

export function periodKey(day: string, period: Period): string {
  const [year, month] = day.split("-").map(Number);
  switch (period) {
    case "daily":
      return day;
    case "weekly": {
      const iso = isoWeek(day);
      return `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
    }
    case "monthly":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "quarterly":
      return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
    case "yearly":
      return String(year);
  }
}

// ---- report -----------------------------------------------------------------

const round2 = (value: number) => Math.round(value * 100) / 100;

export function checkSelection(db: Database, names: string[], prefixes: string[], category?: Category): void {
  for (const name of names) {
    if (name !== UNKNOWN_PROJECT && !db.has(name)) {
      fail(`unknown project "${name}"; register it in the database or check the spelling`);
    }
  }
  for (const prefix of prefixes) {
    if (![...db.keys()].some((name) => matchesPrefix(name, prefix))) {
      fail(`no registered project matches prefix "${prefix}"`);
    }
  }
  if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) {
    fail("category must be personal or professional");
  }
}

function selected(record: EntryRecord, filters: Filters): boolean {
  const names = filters.names ?? [];
  const prefixes = filters.prefixes ?? [];
  if (names.length || prefixes.length) {
    const inNames = names.includes(record.project);
    const inPrefix = prefixes.some((prefix) => matchesPrefix(record.project, prefix));
    if (!inNames && !inPrefix) return false;
  }
  // Uncategorised projects are kept whatever the category filter is.
  return filters.category === undefined || record.category === filters.category || record.category === null;
}

// The range as the Reports controls give it: From and To as typed, not the days in the data.
export function rangeLabel(from: string | null, to: string | null): string {
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `to ${to}`;
  return "no range chosen";
}

export function buildReport(records: EntryRecord[], period: Period, filters: Filters = {}, skipped: string[] = []): Report {
  if (!(PERIODS as readonly string[]).includes(period)) {
    fail(`unknown period "${period}"`);
  }
  let chosen = records.filter((record) => selected(record, filters));
  const days = chosen.map((record) => record.day);
  let start = filters.start ?? (days.length ? days.reduce((a, b) => (b < a ? b : a)) : undefined);
  let end = filters.end ?? (days.length ? days.reduce((a, b) => (b > a ? b : a)) : undefined);
  if (start !== undefined && end !== undefined && start > end) {
    fail(`from ${start} is after to ${end}`);
  }
  if (start !== undefined && end !== undefined) {
    const from = start;
    const to = end;
    chosen = chosen.filter((record) => record.day >= from && record.day <= to);
  }

  const keys: string[] = [];
  if (start !== undefined && end !== undefined) {
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const key = periodKey(day, period);
      if (keys[keys.length - 1] !== key) keys.push(key);
    }
  }

  const by_period: PeriodRow[] = keys.map((key) => {
    const items = chosen.filter((record) => periodKey(record.day, period) === key);
    const closed = items.reduce((sum, record) => sum + (record.minutes ?? 0), 0);
    return {
      period: key,
      hours: round2(closed / 60),
      entries: items.length,
      open_entries: items.filter((record) => record.minutes === null).length,
    };
  });

  const closedTotal = chosen.reduce((sum, record) => sum + (record.minutes ?? 0), 0);
  const groups = new Map<string, EntryRecord[]>();
  for (const record of chosen) {
    groups.set(record.project, [...(groups.get(record.project) ?? []), record]);
  }
  const by_project: ProjectRow[] = [...groups].map(([project, items]) => {
    const minutes = items.reduce((sum, record) => sum + (record.minutes ?? 0), 0);
    return {
      project,
      category: items[0].category,
      hours: round2(minutes / 60),
      entries: items.length,
      open_entries: items.filter((record) => record.minutes === null).length,
      share_percent: closedTotal ? Math.round((1000 * minutes) / closedTotal) / 10 : 0,
    };
  });
  by_project.sort((a, b) => {
    const unknownA = a.project === UNKNOWN_PROJECT;
    const unknownB = b.project === UNKNOWN_PROJECT;
    if (unknownA !== unknownB) return unknownA ? 1 : -1;
    if (a.hours !== b.hours) return b.hours - a.hours;
    return a.project < b.project ? -1 : a.project > b.project ? 1 : 0;
  });

  return {
    period,
    from: start ?? null,
    to: end ?? null,
    projects: filters.names ?? [],
    prefixes: filters.prefixes ?? [],
    category: filters.category ?? null,
    totals: {
      hours: round2(closedTotal / 60),
      entries: chosen.length,
      open_entries: chosen.filter((record) => record.minutes === null).length,
      days: new Set(chosen.map((record) => record.day)).size,
    },
    by_period,
    by_project,
    skipped,
  };
}

export const PRESETS = ["custom", "this-week", "last-week", "this-month", "last-month"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABELS: Record<Preset, string> = {
  custom: "Custom (from/to below)",
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
};

// Today's date in local time, as YYYY-MM-DD.
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The range a preset stands for, counted from today. Weeks run Monday to Sunday, like ISO weeks.
// "custom" has no range of its own, so it returns null.
export function presetRange(preset: Preset, today: string): { start: string; end: string } | null {
  if (preset === "custom") return null;
  if (preset === "this-week" || preset === "last-week") {
    const monday = addDays(today, -((parseDay(today).getUTCDay() + 6) % 7));
    const start = preset === "this-week" ? monday : addDays(monday, -7);
    return { start, end: addDays(start, 6) };
  }
  const [year, month] = today.split("-").map(Number);
  // Date.UTC handles month 0 and day 0 by rolling back into the previous month or year.
  const first = preset === "this-month" ? new Date(Date.UTC(year, month - 1, 1)) : new Date(Date.UTC(year, month - 2, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { start: formatDay(first), end: formatDay(last) };
}

export function splitList(values: string): string[] {
  return values
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

// Descriptions of entries with no registered project, most time first, one per text (case ignored).
export function unregisteredSuggestions(records: EntryRecord[], db: Database): { text: string; minutes: number; entries: number }[] {
  const registered = new Set([...db.keys()].map((name) => name.toLowerCase()));
  const groups = new Map<string, { text: string; minutes: number; entries: number }>();
  for (const record of records) {
    if (record.project !== UNKNOWN_PROJECT) continue;
    const text = record.description.trim();
    if (!text || registered.has(text.toLowerCase())) continue;
    const key = text.toLowerCase();
    const group = groups.get(key) ?? { text, minutes: 0, entries: 0 };
    group.minutes += record.minutes ?? 0;
    group.entries += 1;
    groups.set(key, group);
  }
  const key = (text: string) => text.toLowerCase();
  return [...groups.values()].sort((a, b) => b.minutes - a.minutes || (key(a.text) < key(b.text) ? -1 : key(a.text) > key(b.text) ? 1 : 0));
}
