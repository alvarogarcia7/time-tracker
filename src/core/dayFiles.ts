// Which day file the page opens. The file named in the URL (?name=) is kept when it is in the folder;
// otherwise the newest day is opened, by the date in its header (the same header the parser reads).
import { HEADER_RE } from "./header";

export interface DayFileInfo {
  name: string;
  date: string | null; // YYYY-MM-DD from the header, or null when the header is not a valid date
}

// The date the first non-empty line gives, as YYYY-MM-DD, or null. A header without a year uses defaultYear.
export function headerDate(text: string, defaultYear: number): string | null {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item !== "");
  const match = line === undefined ? null : HEADER_RE.exec(line);
  if (!match) return null;
  const year = match[4] ? Number(match[4]) : defaultYear;
  const month = Number(match[3]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Newest day first. A file with no valid date comes last; ties go by name, later names first.
export function newestFirst(files: DayFileInfo[]): DayFileInfo[] {
  return [...files].sort((a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? 1 : -1;
    }
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
}

// The file to open: the preferred one when it is in the folder, else the newest day. Undefined when there are no files.
export function chooseDayFile(files: DayFileInfo[], preferred: string | null): DayFileInfo | undefined {
  return files.find((file) => file.name === preferred) ?? newestFirst(files)[0];
}

// The file named in a page address, or null.
export function fileInUrl(href: string): string | null {
  return new URL(href).searchParams.get("name");
}

// The same address with the file set to name (kept in ?name=, with the hash as it is).
export function urlWithFile(href: string, name: string): string {
  const url = new URL(href);
  url.searchParams.set("name", name);
  return url.toString();
}

// The local date as YYYY-MM-DD, the same form as a file's header date.
export function localDay(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The shortcuts of the file picker: the last file (the newest day) and today's file. Either is undefined when
// there is none. Today's file is the newest one dated today.
export function shortcutFiles(files: DayFileInfo[], today: string): { last?: DayFileInfo; today?: DayFileInfo } {
  return {
    last: newestFirst(files)[0],
    today: newestFirst(files.filter((file) => file.date === today))[0],
  };
}

// A day's date (YYYY-MM-DD) with its weekday, such as "Mon 2026-11-23".
export function dayWithWeekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${date}`;
}

// The Viewer's day list: the files that parse and the day files that fail, sorted by name, each marked
// when it failed. Errors that are not day files (the project database) are not days, so they are left out.
export function dayListEntries(files: { name: string }[], errors: { name: string }[]): { name: string; failed: boolean }[] {
  const failed = errors.filter((error) => error.name.endsWith(".md")).map((error) => ({ name: error.name, failed: true }));
  const parsed = files.map((file) => ({ name: file.name, failed: false }));
  return [...parsed, ...failed].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
