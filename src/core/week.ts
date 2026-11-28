// The week view: the days of one Monday-to-Sunday week, taken from the day files. No DOM access.
// The day totals work on any range of days, so the reports' duration by day shares them.
import { addDays, periodKey } from "./reports";
import { Entry, TimeEntryDay, Totals, totals } from "./summary";

export const WEEK_DAYS = 7;

// The Monday of the week that holds the day (both are ISO dates, YYYY-MM-DD).
export function mondayOf(day: string): string {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 is Monday
  return addDays(day, -weekday);
}

export function weekDates(monday: string): string[] {
  return Array.from({ length: WEEK_DAYS }, (_, index) => addDays(monday, index));
}

// Every day from start to end, both included. Empty when end comes before start.
export function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export interface WeekDay {
  date: string;
  minutes: number; // closed entries only
  entries: number; // every entry of the day, open ones included
  byProject: Map<string, number>; // minutes per project name, in the order the entries came
}

// One entry of a day, as the day totals need it.
export interface DayRecord {
  day: string; // ISO date, YYYY-MM-DD
  project: string;
  minutes: number | null; // null for an open entry
}

// The totals of each listed day, in the order of dates. Records of other days are left out.
export function dayTotals(records: readonly DayRecord[], dates: readonly string[]): WeekDay[] {
  const byDate = new Map<string, WeekDay>(
    dates.map((date) => [date, { date, minutes: 0, entries: 0, byProject: new Map<string, number>() }]),
  );
  for (const record of records) {
    const day = byDate.get(record.day);
    if (!day) continue;
    day.entries += 1;
    if (record.minutes !== null) {
      day.minutes += record.minutes;
      day.byProject.set(record.project, (day.byProject.get(record.project) ?? 0) + record.minutes);
    }
  }
  return [...byDate.values()];
}

export interface WeekSummary extends Totals {
  monday: string;
  sunday: string;
  label: string; // the ISO week, such as 2026-W46
  days: WeekDay[]; // Monday to Sunday
  entries: Entry[]; // every entry of the week
  daysWithEntries: number;
}

// Adds up the entries of the days that fall in the week. A day file outside the week is left out.
export function summarizeWeek(days: readonly TimeEntryDay[], monday: string): WeekSummary {
  const dates = weekDates(monday);
  const inWeek = days.filter((doc) => dates.includes(doc.date));
  const entries: Entry[] = inWeek.flatMap((doc) => doc.entries);
  const records: DayRecord[] = inWeek.flatMap((doc) =>
    doc.entries.map((entry) => ({ day: doc.date, project: entry.project, minutes: entry.duration_minutes })),
  );
  const weekDays = dayTotals(records, dates);
  return {
    monday,
    sunday: dates[WEEK_DAYS - 1],
    label: periodKey(monday, "weekly"),
    days: weekDays,
    entries,
    daysWithEntries: weekDays.filter((day) => day.entries > 0).length,
    ...totals(entries),
  };
}
