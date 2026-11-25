// The week view: the days of one Monday-to-Sunday week, taken from the day files. No DOM access.
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

export interface WeekDay {
  date: string;
  minutes: number; // closed entries only
  entries: number; // every entry of the day, open ones included
  byProject: Map<string, number>; // minutes per project name, in the order the entries came
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
  const byDate = new Map<string, WeekDay>(
    dates.map((date) => [date, { date, minutes: 0, entries: 0, byProject: new Map<string, number>() }]),
  );
  const entries: Entry[] = [];

  for (const doc of days) {
    const day = byDate.get(doc.date);
    if (!day) continue;
    for (const entry of doc.entries) {
      entries.push(entry);
      day.entries += 1;
      if (entry.duration_minutes !== null) {
        day.minutes += entry.duration_minutes;
        day.byProject.set(entry.project, (day.byProject.get(entry.project) ?? 0) + entry.duration_minutes);
      }
    }
  }

  const weekDays = [...byDate.values()];
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
