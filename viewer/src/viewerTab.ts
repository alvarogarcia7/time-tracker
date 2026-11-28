import {
  Entry,
  ProjectGroup,
  TimeEntryDay,
  axisFor,
  formatMinutes,
  groupByProject,
  hourTicks,
  projectColors,
  segmentsFor,
  tasksOf,
  TaskGroup,
  totals,
  validate,
} from "@core/summary";
import { addDays, localDay } from "@core/reports";
import { dayListEntries, markdownPickMessage } from "@core/dayFiles";
import { shareBlocks } from "./shareView";
import { mondayOf, summarizeWeek } from "@core/week";
import type { Controller, DaysResult, Shell } from "./shell";
import { dot, el } from "./dom";
import { filePicker } from "./filePicker";
import { renderWeek } from "./weekView";
import type { WeekSummary } from "@core/week";

// The page area this tab is mounted in.
let scope: ParentNode = document;

function byId(id: string): HTMLElement {
  const node = scope.querySelector<HTMLElement>(`#${id}`);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

function describeReference(entry: Entry): string {
  return entry.reference ? `same as ${entry.reference.start} (line ${entry.reference.line})` : "";
}

function renderHeader(doc: TimeEntryDay, fileName: string): HTMLElement {
  const header = el("header", "masthead");
  header.append(el("h1", null, doc.date));
  const meta = el("div", "meta");
  const items = [
    fileName,
    doc.tag ? `#${doc.tag}` : "",
    doc.parsed_at ? `parsed ${doc.parsed_at}` : "",
    doc.parser_version ? `parser ${doc.parser_version}` : "",
  ].filter(Boolean);
  meta.textContent = items.join(" · ");
  header.append(meta);
  return header;
}

function renderStats(doc: TimeEntryDay, groups: ProjectGroup[]): HTMLElement {
  const all = totals(doc.entries);
  const row = el("div", "stats");
  const stats: [string, string][] = [
    ["Tracked", formatMinutes(all.minutes)],
    ["Entries", String(all.count)],
    ["Projects", String(groups.filter((g) => g.project !== "unknown").length)],
    ["Open", String(all.open)],
  ];
  for (const [label, value] of stats) {
    const box = el("div", "stat");
    box.append(el("div", "stat-value", value), el("div", "stat-label", label));
    row.append(box);
  }
  return row;
}

// The share of tracked time: one bar, and below it the projects as a tree (see shareView.ts).
function renderShareBar(doc: TimeEntryDay, colors: Map<string, string>): HTMLElement {
  const section = el("section", "card");
  section.append(el("h2", null, "Share of tracked time"), ...shareBlocks(doc.entries, colors));
  return section;
}

// The timeline: one lane per project, entries drawn as coloured blocks at their real times.
function renderTimeline(doc: TimeEntryDay, groups: ProjectGroup[], colors: Map<string, string>): HTMLElement {
  const section = el("section", "card");
  section.append(el("h2", null, "Timeline"));
  const axis = axisFor(doc.entries);
  const timeline = el("div", "timeline");

  const axisRow = el("div", "lane axis-row");
  axisRow.append(el("div", "lane-label"));
  const ticks = el("div", "track axis-track");
  for (const tick of hourTicks(axis)) {
    const label = el("span", "tick", tick.label);
    label.style.left = `${tick.left}%`;
    ticks.append(label);
  }
  axisRow.append(ticks);
  timeline.append(axisRow);

  for (const group of groups) {
    const color = colors.get(group.project) ?? "#888";
    const lane = el("div", "lane");
    const label = el("div", "lane-label");
    label.append(dot(color), el("span", "lane-name", group.project));
    label.append(el("span", "muted", formatMinutes(group.minutes)));
    const track = el("div", "track");

    for (const segment of segmentsFor(group.entries, axis)) {
      const block = el("div", segment.open ? "block open" : "block");
      block.style.left = `${segment.left}%`;
      block.style.width = `${segment.width}%`;
      block.style.background = color;
      const text = segment.entry.description || segment.entry.source;
      block.title = `${segment.entry.start}–${segment.entry.end ?? "open"} · ${text}`;
      if (segment.width > 6) block.textContent = text;
      track.append(block);
    }
    lane.append(label, track);
    timeline.append(lane);
  }

  section.append(timeline);
  return section;
}

function renderEntry(entry: Entry, color: string): HTMLElement {
  const row = el("li", "entry");
  row.style.borderLeftColor = color;
  const head = el("div", "entry-head");
  head.append(el("span", "entry-time", `${entry.start}–${entry.end ?? "open"}`));
  head.append(el("span", "pill", formatMinutes(entry.duration_minutes)));
  row.append(head, el("div", "entry-desc", entry.description || "(no description)"));
  const notes = [describeReference(entry), entry.start_type === "relative" ? `relative: ${entry.time_expression}` : ""]
    .filter(Boolean)
    .join(" · ");
  if (notes) row.append(el("div", "muted small", notes));
  return row;
}

// The tasks of a project that occur more than once, each with its combined time, at the top of the card.
function renderRepeatedTasks(tasks: TaskGroup[]): HTMLElement {
  const box = el("div", "task-totals");
  box.append(el("div", "task-totals-title", "Same task, combined"));
  const list = el("ul", "task-total-list");
  for (const task of tasks) {
    const row = el("li", "task-total");
    const count = `${task.count} entries${task.open ? `, ${task.open} open` : ""}`;
    row.append(
      el("span", "task-total-name", task.description),
      el("span", "task-total-time", formatMinutes(task.minutes)),
      el("span", "muted small", count),
    );
    list.append(row);
  }
  box.append(list);
  return box;
}

function renderGroups(groups: ProjectGroup[], colors: Map<string, string>): HTMLElement {
  const wrap = el("section", "groups");
  for (const group of groups) {
    const color = colors.get(group.project) ?? "#888";
    const card = el("section", "card group");
    const head = el("div", "group-head");
    head.style.borderTopColor = color;
    const name = el("div", "group-title");
    name.append(dot(color), el("span", "lane-name", group.project));
    const amount = `${formatMinutes(group.minutes)} · ${group.count} ${group.count === 1 ? "entry" : "entries"}`;
    head.append(name, el("span", "muted", group.open ? `${amount} · ${group.open} open` : amount));
    const list = el("ul", "entries");
    for (const entry of group.entries) list.append(renderEntry(entry, color));
    card.append(head);
    const repeated = tasksOf(group.entries).filter((task) => task.count > 1);
    if (repeated.length) card.append(renderRepeatedTasks(repeated));
    card.append(list);
    wrap.append(card);
  }
  return wrap;
}

function render(doc: TimeEntryDay, fileName: string): void {
  const colors = projectColors(doc.entries);
  const groups = groupByProject(doc.entries);
  const view = byId("view");
  view.replaceChildren(
    renderHeader(doc, fileName),
    renderStats(doc, groups),
    renderShareBar(doc, colors),
    renderTimeline(doc, groups, colors),
    renderGroups(groups, colors),
  );
  view.classList.remove("hidden");
}

function showError(message: string): void {
  const box = byId("error");
  box.textContent = message;
  box.classList.remove("hidden");
  byId("view").classList.add("hidden");
}

function openDoc(doc: TimeEntryDay, name: string): void {
  byId("error").classList.add("hidden");
  render(doc, name);
}

function openText(text: string, name: string): void {
  try {
    openDoc(validate(JSON.parse(text)), name);
  } catch (err) {
    showError(`Could not read ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function load(file: File): void {
  const reader = new FileReader();
  reader.onload = () => openText(String(reader.result), file.name);
  reader.onerror = () => showError(`Could not read ${file.name}`);
  reader.readAsText(file);
}

const VIEWER_TEMPLATE = `
<div class="mode-bar">
  <div class="tabs" role="group" aria-label="view">
    <button type="button" data-mode="day" aria-pressed="true">Day</button>
    <button type="button" data-mode="week" aria-pressed="false">Week</button>
  </div>
</div>
<div id="day-mode">
  <div class="drop" id="drop">
    <label for="file">Choose a parser output JSON file</label>
    <span class="muted"> or drop it here</span>
    <input type="file" id="file" accept=".json,application/json">
  </div>
  <section id="days" class="card hidden"><div class="muted small">Day in this folder</div><div id="day-picker"></div></section>
  <div id="error" class="error hidden" role="alert"></div>
  <div id="view" class="hidden"></div>
</div>
<div id="week-mode" class="hidden">
  <div id="week-view"></div>
</div>
`;

type Mode = "day" | "week";

// Every day file of the folder, parsed. The day open in the editor is taken as the editor has it, with
// any unsaved changes.
async function loadDays(shell: Shell): Promise<{ days: LoadedDay[]; errors: DaysResult["errors"] }> {
  const result = await shell.days();
  const days: LoadedDay[] = [];
  const errors = [...result.errors];
  for (const file of result.files) {
    try {
      days.push({ name: file.name, day: validate(JSON.parse(file.text)) });
    } catch (err) {
      errors.push({ name: file.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const live = shell.current;
  const index = live ? days.findIndex((item) => item.name === live.name) : -1;
  if (live && index >= 0) days[index] = { name: live.name, day: live.day };
  return { days, errors };
}

interface LoadedDay {
  name: string;
  day: TimeEntryDay;
}

// The viewer tab: a day (the one selected in the editor or here, or a file picked from disk), or the
// week that holds the selected day. The selected day file is shared with the editor.
export function mountViewer(root: HTMLElement, shell: Shell): Controller {
  scope = root;
  root.innerHTML = VIEWER_TEMPLATE;
  let active = false;
  let mode: Mode = "day";
  let chosen = false; // a file picked from disk stays on screen until another day is selected
  let monday: string | null = null; // the week shown; null means the week of the selected day
  let ticket = 0; // a newer load replaces an older one that is still waiting
  const expanded = new Set<string>(); // the week's breakdown rows that are open
  const weekRoot = byId("week-view");
  const picker = filePicker((name) => shell.selectFile(name));
  byId("day-picker").append(picker.element);

  const paintWeek = (summary: WeekSummary, notes: string[]): void => {
    weekRoot.replaceChildren(
      renderWeek(summary, {
        expanded,
        notes,
        move: (weeks) => {
          monday = addDays(summary.monday, 7 * weeks);
          void showWeek();
        },
        today: () => {
          monday = mondayOf(localDay(new Date()));
          void showWeek();
        },
        toggle: (path) => {
          if (expanded.has(path)) expanded.delete(path);
          else expanded.add(path);
          paintWeek(summary, notes);
        },
      }),
    );
  };

  const showWeek = async (): Promise<void> => {
    const current = ++ticket;
    let loaded: Awaited<ReturnType<typeof loadDays>>;
    try {
      loaded = await loadDays(shell);
    } catch (err) {
      if (current === ticket) weekRoot.replaceChildren(el("div", "error", err instanceof Error ? err.message : String(err)));
      return;
    }
    if (current !== ticket) return;
    if (monday === null) {
      const selectedDate = loaded.days.find((item) => item.name === shell.selectedFile())?.day.date;
      monday = mondayOf(selectedDate ?? localDay(new Date()));
    }
    const summary = summarizeWeek(
      loaded.days.map((item) => item.day),
      monday,
    );
    paintWeek(
      summary,
      loaded.errors.map((error) => `${error.name} is not counted: ${error.message}`),
    );
  };

  const showDay = async (): Promise<void> => {
    if (chosen) return;
    const current = ++ticket;
    const name = shell.selectedFile();
    if (!name) {
      byId("view").classList.add("hidden");
      byId("error").classList.add("hidden");
      return;
    }
    let loaded: Awaited<ReturnType<typeof loadDays>>;
    try {
      loaded = await loadDays(shell);
    } catch (err) {
      if (current === ticket) showError(`Could not read ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (current !== ticket) return;
    const found = loaded.days.find((item) => item.name === name);
    if (found) {
      openDoc(found.day, name);
      return;
    }
    const failed = loaded.errors.find((item) => item.name === name);
    showError(failed ? `Could not read ${name}: ${failed.message}` : `${name} is not in this folder.`);
  };

  const listDays = async (): Promise<void> => {
    const days = byId("days");
    let entries: { name: string; failed: boolean }[] = [];
    try {
      const result = await shell.days();
      entries = dayListEntries(result.files, result.errors);
    } catch {
      entries = [];
    }
    if (!entries.length) {
      days.classList.add("hidden");
      return;
    }
    picker.setFiles(
      entries.map((entry) => entry.name),
      shell.selectedFile(),
      entries.filter((entry) => entry.failed).map((entry) => entry.name),
    );
    days.classList.remove("hidden");
  };

  const refresh = async (): Promise<void> => {
    if (mode === "week") {
      await showWeek();
    } else {
      await listDays();
      await showDay();
    }
  };

  const setMode = (next: Mode): void => {
    mode = next;
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-mode]"))) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === next));
    }
    byId("day-mode").classList.toggle("hidden", next !== "day");
    byId("week-mode").classList.toggle("hidden", next !== "week");
    if (active) void refresh();
  };
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-mode]"))) {
    button.addEventListener("click", () => setMode(button.dataset.mode === "week" ? "week" : "day"));
  }

  const pick = (file: File): void => {
    const refusal = markdownPickMessage(file.name);
    if (refusal) {
      showError(refusal); // never read as JSON, and not counted as a loaded day
      return;
    }
    chosen = true;
    ticket += 1;
    load(file);
  };
  const input = byId("file") as HTMLInputElement;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) pick(file);
  });
  const drop = byId("drop");
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer?.files[0];
    if (file) pick(file);
  });

  // A file chosen in the editor or here: the viewer shows it, and its week, when it is shown.
  shell.onSelectFile(() => {
    chosen = false;
    monday = null;
    if (active) void refresh();
  });
  shell.onDataChanged(() => {
    if (active) void refresh();
  });

  return {
    show() {
      active = true;
      void refresh();
    },
    hide() {
      active = false;
    },
  };
}
