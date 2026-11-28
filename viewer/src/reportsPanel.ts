// The reports panel: choose the period, range, projects and category, and see the hours.
import { TaskItem, colorsForProjects, groupByProject, totals, withPrefixes } from "@core/summary";
import type { Controller, Shell } from "./shell";
import { breakdownTable } from "./breakdownView";
import { durationByDay } from "./durationByDay";
import { shareBlocks } from "./shareView";
import { sunburstBlock } from "./sunburstView";
import {
  CATEGORIES,
  CONFIGURATIONS,
  Category,
  DEFAULT_PERIOD,
  DEFAULT_PRESET,
  Database,
  EntryRecord,
  Filters,
  LoadedDay,
  PERIODS,
  PRESETS,
  PRESET_LABELS,
  Period,
  Preset,
  Report,
  buildReport,
  checkSelection,
  configurationFor,
  localDay,
  loadDatabase,
  movePeriod,
  presetForPeriod,
  presetRange,
  rangeLabel,
  recordsFromFiles,
  selectRecords,
  skippedFile,
  skippedLine,
} from "@core/reports";
import { dayTotals, daysBetween } from "@core/week";

interface State {
  db: Database | null;
  files: LoadedDay[];
  errors: string[]; // day files that did not parse, as shown under Skipped files
}

// Opens a day file in the editor at a line: the Editor tab, then the file and line.
function openInEditor(shell: Shell, name: string, line: number): void {
  shell.openTab("editor");
  shell.revealLine(name, line);
}

// A link that opens a day file in the editor, without a line.
export function dayLink(shell: Shell, name: string, text: string = name): HTMLAnchorElement {
  const link = el("a", null, text);
  link.href = "#";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    shell.openTab("editor");
    shell.selectFile(name);
  });
  return link;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "field");
  wrap.append(el("span", "muted small", text), control);
  return wrap;
}

function select(options: readonly string[], labels?: Record<string, string>): HTMLSelectElement {
  const node = el("select");
  for (const option of options) {
    const item = el("option", null, labels?.[option] ?? option);
    item.value = option;
    node.append(item);
  }
  return node;
}

function dateInput(): HTMLInputElement {
  const node = el("input");
  node.type = "date";
  return node;
}

function fileInput(accept: string, multiple: boolean): HTMLInputElement {
  const node = el("input");
  node.type = "file";
  node.accept = accept;
  node.multiple = multiple;
  return node;
}

function bar(percent: number, color: string): HTMLElement {
  const track = el("div", "bar-track");
  const fill = el("div", "bar-fill");
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  fill.style.background = color;
  track.append(fill);
  return track;
}

// The selected records as the viewer shows them: the share of time, the duration by day over the days of the
// range, the project and task breakdown, and the sunburst. The colours cover every project and its parents (see
// withPrefixes). The breakdown's open rows are kept in expanded; toggle opens or closes one.
function selectionViews(
  records: EntryRecord[],
  days: string[],
  colors: Map<string, string>,
  expanded: ReadonlySet<string>,
  toggle: (path: string) => void,
): HTMLElement {
  const wrap = el("div");
  const items: TaskItem[] = records.map((record) => ({
    project: record.project,
    duration_minutes: record.minutes,
    description: record.description,
  }));
  wrap.append(el("h3", null, "Project distribution"));
  wrap.append(...shareBlocks(items, colors));
  if (!records.length) {
    wrap.append(el("p", "muted", "No projects in this selection."));
    return wrap;
  }
  wrap.append(el("h3", null, "Duration by day"));
  const chart = el("div", "week-card");
  chart.append(...durationByDay(dayTotals(records, days), groupByProject(items).map((group) => group.project), colors));
  wrap.append(chart);
  wrap.append(el("h3", null, "Project and task breakdown"));
  wrap.append(breakdownTable(items, totals(items).minutes, colors, { expanded, toggle }));
  wrap.append(el("h3", null, "Sunburst of the times"));
  wrap.append(sunburstBlock(items, colors));
  return wrap;
}

function renderReport(report: Report, range: string, shell: Shell, share: HTMLElement, colors: Map<string, string>): HTMLElement {
  const wrap = el("div", "report");
  const totals = report.totals;
  const scope: string[] = [];
  if (report.projects.length) scope.push(`projects ${report.projects.join(", ")}`);
  if (report.prefixes.length) scope.push(`prefix ${report.prefixes.join(", ")}`);
  if (report.category) scope.push(`${report.category} and uncategorised`);

  const summary = el("div", "stats");
  const stats: [string, string][] = [
    ["Hours", totals.hours.toFixed(2)],
    ["Entries", String(totals.entries)],
    ["Days", String(totals.days)],
    ["Open (not counted)", String(totals.open_entries)],
  ];
  for (const [label, value] of stats) {
    const box = el("div", "stat");
    box.append(el("div", "stat-value", value), el("div", "stat-label", label));
    summary.append(box);
  }
  wrap.append(
    el("p", "muted", `${report.period} · ${range} · ${scope.length ? scope.join(" · ") : "all projects"}`),
    summary,
  );

  wrap.append(el("h3", null, "Hours per period"));
  const maxPeriod = Math.max(0, ...report.by_period.map((p) => p.hours));
  const periods = el("div", "rows");
  for (const row of report.by_period) {
    const line = el("div", "row");
    line.append(
      el("span", "row-label", row.period),
      bar(maxPeriod ? (row.hours / maxPeriod) * 100 : 0, "var(--accent)"),
      el("span", "row-value", `${row.hours.toFixed(2)} h`),
      el("span", "muted small", `${row.entries} entries`),
    );
    periods.append(line);
  }
  if (!report.by_period.length) periods.append(el("p", "muted", "No entries in this range."));
  wrap.append(periods);

  wrap.append(el("h3", null, "Hours per project"));
  const maxProject = Math.max(0, ...report.by_project.map((p) => p.hours));
  const projects = el("div", "rows");
  for (const row of report.by_project) {
    const color = colors.get(row.project) ?? "#888";
    const line = el("div", "row");
    const label = el("span", "row-label");
    const dot = el("span", "dot");
    dot.style.background = color;
    label.append(dot, document.createTextNode(` ${row.project}`));
    line.append(
      label,
      bar(maxProject ? (row.hours / maxProject) * 100 : 0, color),
      el("span", "row-value", `${row.hours.toFixed(2)} h · ${row.share_percent.toFixed(1)}%`),
      el("span", "muted small", `${row.category ?? "uncategorised"} · ${row.entries} entries`),
    );
    projects.append(line);
  }
  if (!report.by_project.length) projects.append(el("p", "muted", "No projects in this selection."));
  wrap.append(projects);
  wrap.append(share);

  if (report.skipped.length) {
    wrap.append(el("h3", null, "Skipped files"));
    const list = el("ul", "muted small");
    for (const item of report.skipped) {
      const entry = el("li");
      const file = skippedFile(item);
      if (file) {
        // The file name opens the day; the line, when the item has one, opens the file at that line.
        entry.append(dayLink(shell, file));
        const rest = item.slice(file.length);
        const target = skippedLine(item);
        const head = target ? /^: line \d+/i.exec(rest)?.[0] : undefined;
        if (target && head) {
          const lineLink = el("a", null, head);
          lineLink.href = "#";
          lineLink.addEventListener("click", (event) => {
            event.preventDefault();
            openInEditor(shell, file, target.line);
          });
          entry.append(lineLink, rest.slice(head.length));
        } else {
          entry.append(rest);
        }
      } else {
        entry.textContent = item;
      }
      list.append(entry);
    }
    wrap.append(list);
  }
  return wrap;
}

// Every prefix of every project name: "client-b:api-review" gives "client-b" and "client-b:api-review".
function prefixesOf(db: Database): string[] {
  const prefixes = new Set<string>();
  for (const name of db.keys()) {
    const parts = name.split(":");
    for (let count = 1; count <= parts.length; count++) prefixes.add(parts.slice(0, count).join(":"));
  }
  return [...prefixes].sort();
}

interface TokenEditor {
  element: HTMLElement;
  values(): string[];
  onChange(listener: () => void): void;
}

// Chips for the chosen values, and a text box with a dropdown of suggestions. Typed text that
// is not in the dropdown is accepted too; the report checks it against the database.
function tokenEditor(placeholder: string, suggestions: () => string[]): TokenEditor {
  const values: string[] = [];
  const listeners: (() => void)[] = [];
  const root = el("div", "tokens");
  const chips = el("div", "chips");
  const input = el("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.setAttribute("autocomplete", "off");
  const list = el("ul", "suggestions hidden");
  list.setAttribute("role", "listbox");
  root.append(chips, input, list);

  let shown: string[] = [];
  let highlight = -1;

  const changed = () => listeners.forEach((listener) => listener());

  function renderChips(): void {
    chips.replaceChildren();
    for (const [index, value] of values.entries()) {
      const chip = el("span", "chip", value);
      const remove = el("button", "chip-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `remove ${value}`);
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", () => {
        values.splice(index, 1);
        renderChips();
        changed();
        input.focus();
      });
      chip.append(remove);
      chips.append(chip);
    }
  }

  function hide(): void {
    list.classList.add("hidden");
    highlight = -1;
  }

  function paint(): void {
    Array.from(list.children).forEach((node, index) => node.classList.toggle("active", index === highlight));
  }

  function refresh(): void {
    const typed = input.value.trim().toLowerCase();
    shown = suggestions().filter((name) => !values.includes(name) && (!typed || name.toLowerCase().includes(typed)));
    list.replaceChildren();
    for (const name of shown.slice(0, 100)) {
      const item = el("li", "suggestion", name);
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => {
        event.preventDefault(); // keep focus in the input
        add(name);
      });
      list.append(item);
    }
    highlight = shown.length ? 0 : -1;
    list.classList.toggle("hidden", shown.length === 0);
    paint();
  }

  function add(value: string): void {
    const text = value.trim();
    input.value = "";
    hide();
    if (!text || values.includes(text)) return;
    values.push(text);
    renderChips();
    changed();
    input.focus();
  }

  input.addEventListener("focus", refresh);
  input.addEventListener("input", refresh);
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!shown.length) return;
      event.preventDefault();
      highlight = (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // An exact match wins, then the highlighted suggestion, then the text as typed.
      const typed = input.value.trim().toLowerCase();
      const exact = suggestions().find((name) => name.toLowerCase() === typed);
      const open = !list.classList.contains("hidden");
      add(exact ?? (open && highlight >= 0 ? shown[highlight] : input.value));
    } else if (event.key === "Escape") {
      hide();
    } else if (event.key === "Backspace" && input.value === "" && values.length) {
      values.pop();
      renderChips();
      changed();
    }
  });

  return {
    element: root,
    values: () => [...values],
    onChange: (listener) => listeners.push(listener),
  };
}

// The reports tab. Its days and database come from the shell, and are read again each time the tab is shown.
export function mountReports(root: HTMLElement, shell: Shell): Controller {
  const state: State = { db: null, files: [], errors: [] };
  const expanded = new Set<string>(); // project rows open in the breakdown

  const periodSelect = select(PERIODS);
  periodSelect.value = DEFAULT_PERIOD;
  const presetSelect = select(PRESETS, PRESET_LABELS);
  presetSelect.value = DEFAULT_PRESET;
  const fromInput = dateInput();
  const toInput = dateInput();
  const projectEditor = tokenEditor("type or pick a project", () => (state.db ? ["unknown", ...state.db.keys()] : []));
  const prefixEditor = tokenEditor("type or pick a prefix", () => (state.db ? prefixesOf(state.db) : []));
  const categorySelect = select(["", ...CATEGORIES], { "": "all categories" });
  const dbInput = fileInput(".yml,.yaml", false);
  const dayInput = fileInput(".json,application/json", true);
  const status = el("p", "muted small");
  const result = el("div");

  // Previous and next move from and to together, by one period of the period control.
  const previous = el("button", null, "Previous");
  previous.type = "button";
  const next = el("button", null, "Next");
  next.type = "button";
  const dates = el("div", "date-range");
  dates.append(previous, labelled("From", fromInput), labelled("To", toInput), next);

  // Basic configurations, hidden in an accordion.
  const configurations = el("details", "configurations");
  configurations.append(el("summary", null, "Basic configurations"));
  const configButtons = el("div", "config-buttons");
  for (const config of CONFIGURATIONS) {
    const button = el("button", null, config.label);
    button.type = "button";
    button.addEventListener("click", () => applyConfiguration(config.name));
    configButtons.append(button);
  }
  configurations.append(configButtons);

  const form = el("div", "form");
  form.append(
    labelled("Period", periodSelect),
    labelled("Range", presetSelect),
    dates,
    labelled("Projects", projectEditor.element),
    labelled("Prefixes", prefixEditor.element),
    labelled("Category", categorySelect),
    configurations,
  );
  const files = el("div", "form");
  files.append(labelled("Project database (projects.yml)", dbInput), labelled("Day files (.json)", dayInput));

  root.replaceChildren(el("h2", null, "Reports"), form, files, status, result);
  root.classList.remove("hidden");

  function describe(): void {
    const dbText = state.db ? `${state.db.size} projects` : "no project database";
    status.textContent = `${dbText} · ${state.files.length} day file(s)`;
  }

  function toggleProject(path: string): void {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    run();
  }

  function run(): void {
    result.replaceChildren();
    describe();
    if (!state.db) {
      result.append(el("p", "muted", "Load the project database to see reports."));
      return;
    }
    if (!state.files.length) {
      result.append(el("p", "muted", "Load the day files (parser output .json) to see reports."));
      return;
    }
    try {
      const names = projectEditor.values();
      const prefixes = prefixEditor.values();
      const category = categorySelect.value ? (categorySelect.value as Category) : undefined;
      checkSelection(state.db, names, prefixes, category);
      const { records, skipped } = recordsFromFiles(state.files, state.db);
      skipped.push(...state.errors);
      const filters: Filters = {
        start: fromInput.value || undefined,
        end: toInput.value || undefined,
        names,
        prefixes,
        category,
      };
      const report = buildReport(records, periodSelect.value as Period, filters, skipped);
      const { chosen, start: first, end: last } = selectRecords(records, filters);
      const days = first && last ? daysBetween(first, last) : [];
      const colors = colorsForProjects(withPrefixes(chosen.map((record) => record.project)));
      const views = selectionViews(chosen, days, colors, expanded, toggleProject);
      result.append(renderReport(report, rangeLabel(fromInput.value || null, toInput.value || null), shell, views, colors));
    } catch (err) {
      const box = el("div", "error", err instanceof Error ? err.message : String(err));
      result.append(box);
    }
  }

  async function readFiles(list: FileList): Promise<LoadedDay[]> {
    return Promise.all(Array.from(list).map(async (file) => ({ name: file.name, text: await file.text() })));
  }

  dbInput.addEventListener("change", async () => {
    const file = dbInput.files?.[0];
    if (!file) return;
    try {
      state.db = loadDatabase(await file.text(), file.name);
    } catch (err) {
      state.db = null;
      result.replaceChildren(el("div", "error", err instanceof Error ? err.message : String(err)));
      describe();
      return;
    }
    run();
  });

  dayInput.addEventListener("change", async () => {
    if (!dayInput.files) return;
    const picked = await readFiles(dayInput.files);
    // A .md file is not loaded: Reports needs the JSON day files, and the file is not counted.
    const markdown = picked.filter((file) => /\.md$/i.test(file.name));
    state.files = picked.filter((file) => !/\.md$/i.test(file.name));
    state.errors = markdown.map((file) => `${file.name}: Reports needs JSON`);
    if (!state.files.length && markdown.length) {
      status.textContent = "";
      result.replaceChildren(el("div", "error", "Reports needs JSON"));
      return;
    }
    run();
  });

  // A preset fills from and to, counted from today.
  function applyPreset(preset: Preset): void {
    const range = presetRange(preset, localDay(new Date()));
    if (range) {
      fromInput.value = range.start;
      toInput.value = range.end;
    }
  }
  applyPreset(DEFAULT_PRESET);
  presetSelect.addEventListener("change", () => {
    applyPreset(presetSelect.value as Preset);
    run();
  });

  // A configuration sets the range and the category together.
  function applyConfiguration(name: string): void {
    const config = configurationFor(name, localDay(new Date()));
    presetSelect.value = config.preset;
    categorySelect.value = config.category;
    fromInput.value = config.start;
    toInput.value = config.end;
    run();
  }

  // Moves from and to by one period; the dates no longer match a preset, so the range is custom.
  function shift(count: number): void {
    if (!fromInput.value || !toInput.value) return;
    const moved = movePeriod({ start: fromInput.value, end: toInput.value }, periodSelect.value as Period, count);
    fromInput.value = moved.start;
    toInput.value = moved.end;
    presetSelect.value = "custom";
    run();
  }
  previous.addEventListener("click", () => shift(-1));
  next.addEventListener("click", () => shift(1));
  // Changing from or to by hand makes the range custom.
  for (const control of [fromInput, toInput]) {
    control.addEventListener("change", () => {
      presetSelect.value = "custom";
      run();
    });
  }
  // A period brings the range that fits it: this week for daily and weekly, this month for monthly, and so on.
  periodSelect.addEventListener("change", () => {
    presetSelect.value = presetForPeriod(periodSelect.value as Period);
    applyPreset(presetSelect.value as Preset);
    run();
  });
  categorySelect.addEventListener("change", run);
  projectEditor.onChange(run);
  prefixEditor.onChange(run);

  // Reads the days and the database from the shell, then reports again.
  const refresh = async (): Promise<void> => {
    try {
      const days = await shell.days();
      state.files = days.files;
      state.errors = days.errors.map((error) => `${error.name}: ${error.message}`);
      const database = await shell.database();
      if (database) state.db = loadDatabase(database.text, "projects.yml");
    } catch (err) {
      state.errors = [`could not read the folder: ${err instanceof Error ? err.message : String(err)}`];
    }
    run();
  };
  void refresh();

  return {
    show: () => void refresh(),
    hide: () => undefined,
  };
}
