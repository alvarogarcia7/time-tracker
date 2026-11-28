// The week viewer: the week's totals, a bar per day stacked by project, each project's share, and the
// week broken down by project and task. The layout follows the usual time-tracking week report.
import { ProjectGroup, UNKNOWN_COLOR, formatMinutes, formatShare, groupByProject, projectColors } from "@core/summary";
import type { WeekSummary } from "@core/week";
import { breakdownTable } from "./breakdownView";
import { durationByDay } from "./durationByDay";
import { dot, el } from "./dom";

export interface WeekOptions {
  expanded: ReadonlySet<string>; // project paths whose rows are open in the breakdown
  notes: string[]; // what could not be read, shown under the week
  move(weeks: number): void;
  today(): void;
  toggle(path: string): void;
}

// "09 – 15 Nov 2026", for the week's Monday and Sunday.
function rangeLabel(week: WeekSummary): string {
  const monday = week.monday.slice(8, 10);
  const sunday = new Date(`${week.sunday}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${monday} – ${sunday}`;
}

function section(title: string, className = "card"): HTMLElement {
  const card = el("section", className);
  card.append(el("h2", null, title));
  return card;
}

function header(week: WeekSummary, options: WeekOptions): HTMLElement {
  const head = el("header", "week-head");
  const nav = el("div", "week-nav");
  const previous = el("button", "week-step", "‹");
  previous.type = "button";
  previous.title = "previous week";
  previous.addEventListener("click", () => options.move(-1));
  const next = el("button", "week-step", "›");
  next.type = "button";
  next.title = "next week";
  next.addEventListener("click", () => options.move(1));
  const today = el("button", null, "This week");
  today.type = "button";
  today.addEventListener("click", () => options.today());
  const title = el("div", "week-title");
  title.append(el("h1", null, rangeLabel(week)), el("span", "pill", week.label));
  nav.append(previous, title, next);
  head.append(nav, today);
  return head;
}

function stats(week: WeekSummary): HTMLElement {
  const average = week.daysWithEntries ? Math.round(week.minutes / week.daysWithEntries) : 0;
  const row = el("div", "stats");
  const tiles: [string, string][] = [
    ["Total hours", formatMinutes(week.minutes)],
    ["Average per tracked day", formatMinutes(average)],
    ["Days tracked", `${week.daysWithEntries} of 7`],
    ["Entries", String(week.count)],
    ["Open", String(week.open)],
  ];
  for (const [label, value] of tiles) {
    const box = el("div", "stat");
    box.append(el("div", "stat-value", value), el("div", "stat-label", label));
    row.append(box);
  }
  return row;
}

// The share of the week for each project, as a ring with the total in its middle.
function distribution(week: WeekSummary, groups: ProjectGroup[], colors: Map<string, string>): HTMLElement {
  const card = section("Project distribution", "card week-card");
  const parts: string[] = [];
  let start = 0;
  for (const group of groups) {
    if (group.minutes <= 0 || week.minutes <= 0) continue;
    const end = start + (group.minutes / week.minutes) * 100;
    parts.push(`${colors.get(group.project) ?? UNKNOWN_COLOR} ${start}% ${end}%`);
    start = end;
  }
  const ring = el("div", "donut");
  ring.style.background = parts.length ? `conic-gradient(${parts.join(", ")})` : "var(--border)";
  const hole = el("div", "donut-hole");
  hole.append(el("strong", null, formatMinutes(week.minutes)), el("span", "muted small", "total"));
  ring.append(hole);

  const list = el("ul", "share-list");
  for (const group of groups) {
    const row = el("li", "share-list-row");
    row.append(
      dot(colors.get(group.project)),
      el("span", "share-name-text", group.project),
      el("span", "muted", formatMinutes(group.minutes)),
      el("span", "share-percent", formatShare(group.minutes, week.minutes)),
    );
    list.append(row);
  }
  card.append(ring, list);
  return card;
}

// The breakdown: each project with its sub-projects and its tasks (the descriptions) under it.
function breakdown(week: WeekSummary, colors: Map<string, string>, options: WeekOptions): HTMLElement {
  const card = section("Project and task breakdown", "card");
  card.append(breakdownTable(week.entries, week.minutes, colors, options));
  return card;
}

export function renderWeek(week: WeekSummary, options: WeekOptions): HTMLElement {
  const root = el("div", "week");
  root.append(header(week, options));
  for (const note of options.notes) root.append(el("div", "muted small week-note", note));
  if (week.count === 0) {
    root.append(el("div", "muted-note", "No entries in this week."));
    return root;
  }
  const colors = projectColors(week.entries);
  const groups = groupByProject(week.entries);
  root.append(stats(week));
  const pair = el("div", "week-pair");
  const dayCard = section("Duration by day", "card week-card");
  dayCard.append(...durationByDay(week.days, groups.map((group) => group.project), colors));
  pair.append(dayCard, distribution(week, groups, colors));
  root.append(pair, breakdown(week, colors, options));
  return root;
}
