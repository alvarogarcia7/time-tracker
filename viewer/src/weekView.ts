// The week viewer: the week's totals, a bar per day stacked by project, each project's share, and the
// week broken down by project and task. The layout follows the usual time-tracking week report.
import {
  ProjectGroup,
  ProjectNode,
  UNKNOWN_COLOR,
  formatMinutes,
  formatShare,
  groupByProject,
  projectColors,
  projectTree,
  tasksOf,
} from "@core/summary";
import type { TaskGroup } from "@core/summary";
import type { WeekSummary } from "@core/week";
import { dot, el } from "./dom";

export interface WeekOptions {
  expanded: ReadonlySet<string>; // project paths whose rows are open in the breakdown
  notes: string[]; // what could not be read, shown under the week
  move(weeks: number): void;
  today(): void;
  toggle(path: string): void;
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// "Mon 09-11": the weekday, then the day and month as in the file names.
function dayLabel(date: string, index: number): string {
  return `${WEEKDAY_NAMES[index]} ${date.slice(8, 10)}-${date.slice(5, 7)}`;
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

// Hour gridlines and the day columns. Each column is one day, stacked by project, bottom to top.
function dayChart(week: WeekSummary, groups: ProjectGroup[], colors: Map<string, string>): HTMLElement {
  const card = section("Duration by day", "card week-card");
  const peak = Math.max(0, ...week.days.map((day) => day.minutes));
  const top = Math.max(60, Math.ceil(peak / 60) * 60); // the axis runs to a whole hour
  const hourStep = top > 8 * 60 ? 2 : 1;
  const projects = groups.map((group) => group.project);

  const plot = el("div", "week-plot");
  for (let hour = 0; hour * 60 <= top; hour += hourStep) {
    const line = el("div", "week-tick");
    line.style.bottom = `${((hour * 60) / top) * 100}%`;
    line.append(el("span", "week-tick-label", `${hour}h`));
    plot.append(line);
  }
  const columns = el("div", "week-columns");
  week.days.forEach((day, index) => {
    const column = el("div", "week-col");
    if (day.minutes > 0) {
      const height = (day.minutes / top) * 100;
      const stack = el("div", "week-bar");
      stack.style.height = `${height}%`;
      for (const project of projects) {
        const minutes = day.byProject.get(project);
        if (!minutes) continue;
        const segment = el("div", "week-seg");
        segment.style.flexGrow = String(minutes);
        segment.style.background = colors.get(project) ?? UNKNOWN_COLOR;
        segment.title = `${project}: ${formatMinutes(minutes)}`;
        stack.append(segment);
      }
      const total = el("span", "week-total", formatMinutes(day.minutes));
      total.style.bottom = `calc(${height}% + 4px)`;
      column.append(stack, total);
    }
    column.title = `${dayLabel(day.date, index)}: ${formatMinutes(day.minutes)}`;
    columns.append(column);
  });
  plot.append(columns);

  const labels = el("div", "week-labels");
  week.days.forEach((day, index) => labels.append(el("span", "week-label", dayLabel(day.date, index))));

  const legend = el("div", "legend");
  for (const group of groups) {
    const item = el("div", "legend-item");
    item.append(dot(colors.get(group.project)), el("span", "legend-name", group.project));
    legend.append(item);
  }
  card.append(plot, labels, legend);
  return card;
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
  const wrap = el("div", "table-wrap");
  const table = el("table", "entry-table breakdown");
  const head = el("tr");
  for (const label of ["Project | task", "Duration", "Duration %"]) head.append(el("th", label === "Project | task" ? null : "num", label));
  table.append(el("thead"), el("tbody"));
  table.querySelector("thead")?.append(head);
  const body = table.querySelector("tbody") as HTMLElement;

  const share = (minutes: number) => formatShare(minutes, week.minutes);
  const taskRow = (task: TaskGroup, depth: number) => {
    const row = el("tr", "task-row");
    const name = el("td");
    name.style.paddingLeft = `${26 + depth * 20}px`;
    name.append(el("span", "muted", "· "), document.createTextNode(task.description));
    if (task.count > 1) name.append(el("span", "muted small", ` ×${task.count}`));
    row.append(name, el("td", "num", formatMinutes(task.minutes)), el("td", "num", share(task.minutes)));
    body.append(row);
  };
  const projectRows = (nodes: ProjectNode[], depth: number) => {
    for (const node of nodes) {
      const expandable = node.children.length > 0 || node.own.length > 0;
      const open = expandable && options.expanded.has(node.path);
      const row = el("tr", depth === 0 ? "project-row" : "subproject-row");
      const name = el("td");
      name.style.paddingLeft = `${8 + depth * 20}px`;
      if (expandable) {
        const toggle = el("button", "chevron", open ? "▾" : "▸");
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(open));
        toggle.title = open ? "collapse" : "expand";
        toggle.addEventListener("click", () => options.toggle(node.path));
        name.append(toggle);
      } else {
        name.append(el("span", "chevron-space"));
      }
      name.append(dot(colors.get(node.path)), el("span", depth === 0 ? "lane-name" : null, node.label));
      row.append(name, el("td", "num", formatMinutes(node.minutes)), el("td", "num", share(node.minutes)));
      body.append(row);
      if (open) {
        projectRows(node.children, depth + 1);
        for (const task of tasksOf(node.own)) taskRow(task, depth + 1);
      }
    }
  };
  projectRows(projectTree(week.entries), 0);

  const total = el("tr", "total-row");
  total.append(
    el("td", "lane-name", "TOTAL"),
    el("td", "num", formatMinutes(week.minutes)),
    el("td", "num", week.minutes > 0 ? "100%" : "0%"),
  );
  body.append(total);
  wrap.append(table);
  card.append(wrap);
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
  pair.append(dayChart(week, groups, colors), distribution(week, groups, colors));
  root.append(pair, breakdown(week, colors, options));
  return root;
}
