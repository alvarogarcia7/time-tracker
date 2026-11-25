// The web editor page: a plain text view, and an entries view with dropdowns.
import { formatMinutes } from "@core/summary";
import { Database, detectProjectInDb, loadDatabase } from "@core/reports";
import type { TimeEntryDay } from "@core/summary";
import type { Controller, Shell } from "../shell";
import { EditorApi, StoreError } from "@core/workspace";
import { EDITOR_TEMPLATE } from "./template";
import {
  CategoryFilter,
  ProjectFilter,
  RELATIVE_TIMES,
  classify,
  headerIndex,
  matchesFilters,
  insertAfter,
  joinLines,
  timeAfter,
  removeLine,
  setLine,
  setTask,
  splitLines,
  withProject,
} from "@core/editorModel";

interface FileInfo {
  name: string;
  hash: string;
}

interface DayEntry {
  line: number;
  start: string;
  end: string | null;
  duration_minutes: number | null;
  project: string;
  description: string;
  reference: { start: string; line: number } | null;
}

type ParseResult = { ok: true; day: { entries: DayEntry[]; tag: string | null } } | { ok: false; error: string };

interface State {
  files: FileInfo[];
  name: string;
  text: string;
  saved: string;
  base: string;
  parse: ParseResult | null;
  good: DayEntry[]; // entries of the last successful parse, for the suggestions
  notice: { text: string; isError: boolean } | null;
  db: Database | null;
  vocabulary: string[];
  view: "entries" | "plain";
  filters: { category: CategoryFilter; project: ProjectFilter };
}

const state: State = {
  files: [],
  name: "",
  text: "",
  saved: "",
  base: "",
  parse: null,
  good: [],
  notice: null,
  db: null,
  vocabulary: [],
  view: "entries",
  filters: { category: "all", project: "all" },
};

let parseTimer: number | undefined;

// The page area this editor is mounted in, the shared shell, and whether the tab is showing.
let scope: ParentNode = document;
let shell: Shell | null = null;
let active = false;

function byId(id: string): HTMLElement {
  const node = scope.querySelector<HTMLElement>(`#${id}`);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The operations of the page, set when the editor is mounted.
let api!: EditorApi;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusOf(err: unknown): number {
  return err instanceof StoreError ? err.status : 0;
}

function dirty(): boolean {
  return state.text !== state.saved;
}

function confirmDiscard(): boolean {
  return !dirty() || window.confirm("Discard the unsaved changes?");
}

// ---- choosing a file -------------------------------------------------------------

function setFileInput(name: string): void {
  (byId("editor-file") as HTMLInputElement).value = name;
}

// A text box that filters the files as you type. Enter or a click opens the file; leaving the
// box or pressing Escape puts back the name of the open file, so a half-typed name opens nothing.
function wireFilePicker(): void {
  const input = byId("editor-file") as HTMLInputElement;
  const list = byId("file-list");
  let shown: string[] = [];
  let highlight = -1;
  let navigated = false;

  const hide = () => {
    list.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    highlight = -1;
  };
  const paint = () => Array.from(list.children).forEach((node, index) => node.classList.toggle("active", index === highlight));

  const choose = (name: string) => {
    hide();
    input.blur();
    if (name === state.name) setFileInput(state.name);
    else void open(name);
  };

  const refresh = (showAll: boolean) => {
    const typed = showAll ? "" : input.value.trim().toLowerCase();
    shown = state.files.map((file) => file.name).filter((name) => !typed || name.toLowerCase().includes(typed));
    list.replaceChildren();
    for (const name of shown) {
      const item = el("li", "suggestion", name);
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => {
        event.preventDefault(); // keep the focus until the file is chosen
        choose(name);
      });
      list.append(item);
    }
    highlight = shown.length ? 0 : -1;
    navigated = false;
    list.classList.toggle("hidden", shown.length === 0);
    input.setAttribute("aria-expanded", String(shown.length > 0));
    paint();
  };

  input.addEventListener("focus", () => {
    input.select();
    refresh(true);
  });
  input.addEventListener("input", () => refresh(false));
  input.addEventListener("blur", () => {
    hide();
    setFileInput(state.name);
  });
  input.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      highlight = (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      navigated = true;
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const typed = input.value.trim().toLowerCase();
      const exact = shown.find((name) => name.toLowerCase() === typed);
      const only = shown.length === 1 ? shown[0] : undefined;
      const pick = exact ?? only ?? (navigated && highlight >= 0 ? shown[highlight] : undefined);
      if (pick !== undefined) choose(pick);
      else setFileInput(state.name);
    } else if (event.key === "Escape") {
      setFileInput(state.name);
      input.blur();
    }
  });
}

// ---- loading and saving -----------------------------------------------------

async function loadFiles(preferred: string | null): Promise<void> {
  state.files = await api.files();
  const first = state.files.find((file) => file.name === preferred) ?? state.files[0];
  if (first) await open(first.name, true);
  else showStatus("No .md files in this folder.", true);
}

async function open(name: string, force = false): Promise<void> {
  if (!force && !confirmDiscard()) {
    setFileInput(state.name);
    return;
  }
  let file: { name: string; text: string; hash: string };
  try {
    file = await api.read(name);
  } catch (err) {
    showStatus(errorText(err), true);
    return;
  }
  state.name = file.name;
  state.text = file.text;
  state.saved = file.text;
  state.base = file.hash;
  setFileInput(name);
  await parseNow();
  shell?.selectFile(state.name); // the viewer shows the file the editor has open
}

async function save(): Promise<void> {
  if (!dirty()) return;
  let saved: Awaited<ReturnType<EditorApi["write"]>>;
  try {
    saved = await api.write(state.name, state.text, state.base);
  } catch (err) {
    const note = statusOf(err) === 409 ? " Use Reload to see the file on disk." : "";
    showStatus(`${errorText(err)}${note}`, true);
    return;
  }
  state.saved = state.text;
  state.base = saved.hash;
  state.parse = saved.parse as unknown as ParseResult;
  render();
  showStatus("Saved. The previous version is kept as a backup.", false);
}

// A new day file: the name is the date (YYYY-MM-DD.md) and the first line is the header DD/MM/YYYY.
async function createDay(): Promise<void> {
  if (!confirmDiscard()) return;
  const value = (byId("new-day") as HTMLInputElement).value;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    showStatus("Pick a date first.", true);
    return;
  }
  const [, year, month, day] = match;
  const name = `${value}.md`;
  try {
    await api.create(name, `${day}/${month}/${year}\n- [ ] \n`);
    showStatus(`Created ${name}.`, false);
  } catch (err) {
    if (statusOf(err) !== 409) {
      showStatus(errorText(err), true);
      return;
    }
    showStatus(`${name} already exists; it is open below.`, false);
  }
  state.files = await api.files();
  await open(name, true);
}

// YYYY-MM-DD in the local time zone, the value of a date input.
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function reload(): Promise<void> {
  if (!confirmDiscard() && !window.confirm("Reload and lose the unsaved changes?")) return;
  await open(state.name, true);
}

// ---- parsing and editing ------------------------------------------------------

function scheduleParse(): void {
  window.clearTimeout(parseTimer);
  parseTimer = window.setTimeout(() => void parseNow(), 250);
}

async function parseNow(): Promise<void> {
  try {
    state.parse = (await api.parse(state.text)) as unknown as ParseResult;
    if (state.parse.ok) state.good = state.parse.day.entries;
  } catch (err) {
    showStatus(errorText(err), true);
  }
  render();
}

// Every edit goes through here, so the text, the status and both views stay in step.
function setText(text: string): void {
  state.text = text;
  state.notice = null;
  scheduleParse();
  render();
}

// The computed start and end of each line, when the whole file parses.
function entryAt(index: number): DayEntry | undefined {
  return state.parse?.ok ? state.parse.day.entries.find((entry) => entry.line === index + 1) : undefined;
}

// The project of an entry comes from its description, so the browser can work it out even
// when the file does not parse. An ambiguous description shows as an error.
function projectOf(description: string): { project: string; error?: string } {
  if (!state.db) return { project: "" };
  try {
    return { project: detectProjectInDb(description, state.db) };
  } catch (err) {
    return { project: "", error: err instanceof Error ? err.message : String(err) };
  }
}

function showStatus(message: string, isError: boolean): void {
  state.notice = { text: message, isError };
  renderStatus();
}

function renderStatus(): void {
  const node = byId("status");
  const parts = [dirty() ? "Unsaved changes" : "Saved"];
  if (state.notice) {
    node.textContent = state.notice.text;
    node.classList.toggle("error", state.notice.isError);
  } else if (state.parse?.ok) {
    const minutes = state.parse.day.entries.reduce((sum, entry) => sum + (entry.duration_minutes ?? 0), 0);
    parts.push(`${state.parse.day.entries.length} entries, ${formatMinutes(minutes)} tracked`);
    node.textContent = parts.join(" · ");
    node.classList.remove("error");
  } else if (state.parse) {
    node.textContent = `${parts.join(" · ")} · parse error: ${state.parse.error}`;
    node.classList.add("error");
  } else {
    node.textContent = parts.join(" · ");
    node.classList.remove("error");
  }
  (byId("save") as HTMLButtonElement).disabled = !dirty();
}

// ---- dropdown for a single value ------------------------------------------------

// A text box with a dropdown. Enter or a click commits; typed text that is not in the list is
// accepted too. Escape and an unchanged value leave the stored value alone.
function combobox(value: string, options: () => string[], commit: (value: string) => void): HTMLElement {
  const wrap = el("div", "combo");
  const input = el("input");
  input.type = "text";
  input.value = value;
  input.setAttribute("autocomplete", "off");
  const list = el("ul", "suggestions hidden");
  let shown: string[] = [];
  let highlight = -1;
  let navigated = false; // Enter takes the highlighted suggestion only after the arrow keys were used
  let finished = false;

  const finish = (next: string | null) => {
    if (finished) return;
    finished = true;
    if (next !== null && next !== value) commit(next);
    else render();
  };

  const paint = () => Array.from(list.children).forEach((node, index) => node.classList.toggle("active", index === highlight));

  const refresh = () => {
    const typed = input.value.trim().toLowerCase();
    shown = [...new Set(options())].filter((option) => !typed || option.toLowerCase().includes(typed)).slice(0, 60);
    list.replaceChildren();
    for (const option of shown) {
      const item = el("li", "suggestion", option);
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        finish(option);
      });
      list.append(item);
    }
    highlight = shown.length ? 0 : -1;
    navigated = false;
    list.classList.toggle("hidden", shown.length === 0);
    paint();
  };

  input.addEventListener("focus", refresh);
  input.addEventListener("input", refresh);
  input.addEventListener("blur", () => finish(input.value.trim()));
  input.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      highlight = (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      navigated = true;
      paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const typed = input.value.trim();
      const exact = shown.find((option) => option.toLowerCase() === typed.toLowerCase());
      finish(exact ?? (navigated && highlight >= 0 ? shown[highlight] : typed));
    } else if (event.key === "Escape") {
      input.value = value;
      list.classList.add("hidden");
      finish(null);
    }
  });

  wrap.append(input, list);
  return wrap;
}

function timeOptions(): string[] {
  const starts = state.good.map((entry) => entry.start);
  return [...new Set([...starts, ...RELATIVE_TIMES])];
}

// Descriptions, and start times to refer to an earlier entry with.
function descriptionOptions(): string[] {
  const starts = state.good.map((entry) => entry.start);
  return [...new Set([...state.good.map((entry) => entry.description), ...starts, ...state.vocabulary])].filter(Boolean);
}

// ---- entries view -----------------------------------------------------------

function renderEntries(): void {
  const view = byId("entries");
  const lines = splitLines(state.text);
  const header = headerIndex(lines);
  const table = el("table", "entry-table");
  const head = el("tr");
  for (const label of ["Line", "Start", "End", "Time", "Description", "Project", "Duration", ""]) {
    head.append(el("th", null, label));
  }
  table.append(el("thead"), el("tbody"));
  table.querySelector("thead")?.append(head);
  const body = table.querySelector("tbody") as HTMLElement;

  let shown = 0;
  let total = 0;
  lines.forEach((line, index) => {
    const parsed = classify(line);
    if (index === header) {
      const row = el("tr", "header-row");
      const cell = el("td", null);
      cell.colSpan = 8;
      const input = el("input", "header-input");
      input.value = line;
      input.placeholder = "date, for example 11/11 or #toggl 11/11";
      input.addEventListener("change", () => setText(joinLines(setLine(lines, index, input.value.trim()))));
      cell.append(input);
      row.append(cell);
      body.append(row);
      return;
    }
    if (line.trim() === "") return;
    if (parsed.kind === "other") {
      const row = el("tr", "other-row");
      const cell = el("td", "muted small", line.trim() || "(empty)");
      cell.colSpan = 8;
      row.append(cell);
      body.append(row);
      return;
    }
    total += 1;
    // The parser gives a reference (such as "8") the description of the entry it points to.
    const effective = entryAt(index)?.description ?? parsed.description;
    const { project } = projectOf(effective);
    const category = project ? state.db?.get(project)?.category ?? null : null;
    if (!matchesFilters(project, category, state.filters)) return;
    shown += 1;
    body.append(entryRow(lines, index, parsed.time, parsed.description));
  });
  byId("filter-count").textContent = total === shown ? `${total} entries` : `${shown} of ${total} entries shown`;

  if (!body.children.length) {
    const row = el("tr");
    const cell = el("td", "muted", total ? "No entries match the filters." : "No entries yet.");
    cell.colSpan = 8;
    row.append(cell);
    body.append(row);
  }
  const wrap = el("div", "table-wrap");
  wrap.append(table);
  view.replaceChildren(wrap);
}

function entryRow(lines: string[], index: number, time: string, description: string): HTMLElement {
  const entry = entryAt(index);
  const row = el("tr", entry ? null : "unparsed"); // unparsed: no start and end while the file has an error
  row.append(el("td", "muted", String(index + 1)));
  row.append(el("td", null, entry?.start ?? "-"));
  row.append(el("td", null, entry ? entry.end ?? "open" : "-"));

  const timeCell = el("td");
  timeCell.append(
    combobox(time, timeOptions, (value) => setText(setTask(lines, index, { time: value }).join("\n"))),
  );
  row.append(timeCell);

  const descriptionCell = el("td");
  descriptionCell.append(
    combobox(description, descriptionOptions, (value) =>
      setText(setTask(lines, index, { description: value }).join("\n")),
    ),
  );
  if (entry?.reference) descriptionCell.append(el("div", "muted small", `copies ${entry.description}`));
  row.append(descriptionCell);

  row.append(projectCell(lines, index, description));
  row.append(el("td", "num", entry?.duration_minutes === null || !entry ? "-" : formatMinutes(entry.duration_minutes)));

  const actions = el("td", "actions");
  const add = el("button", null, "+");
  add.type = "button";
  add.title = "add an entry after this one, starting when this one ends";
  add.addEventListener("click", () =>
    setText(joinLines(insertAfter(lines, index, timeAfter(lines, index, entry, new Date())))),
  );
  const remove = el("button", null, "×");
  remove.type = "button";
  remove.title = "delete this entry";
  remove.addEventListener("click", () => setText(joinLines(removeLine(lines, index))));
  actions.append(add, remove);
  row.append(actions);
  return row;
}

function projectCell(lines: string[], index: number, description: string): HTMLElement {
  const cell = el("td");
  const { project: current, error } = projectOf(entryAt(index)?.description ?? description);
  if (error) cell.title = error;
  cell.append(
    combobox(
      current,
      () => (state.db ? [...state.db.keys()] : []),
      (value) => void chooseProject(lines, index, value),
    ),
  );
  return cell;
}

// Adds a project that is not in the database yet to projects.yml, then sets it on the entry.
async function createProject(name: string): Promise<boolean> {
  try {
    await api.createProject(name);
    const list = await api.projects();
    state.db = loadDatabase(list.text, "projects.yml");
    return true;
  } catch (err) {
    showStatus(errorText(err), true);
    return false;
  }
}

// A reference copies the description of the entry it points to, so the project is set on that text.
async function chooseProject(lines: string[], index: number, value: string): Promise<void> {
  const parsed = classify(lines[index]);
  if (parsed.kind !== "task") return;
  const base = entryAt(index)?.description ?? parsed.description;
  const created = Boolean(value) && !state.db?.has(value);
  if (created && !(await createProject(value))) {
    render();
    return;
  }
  const change = withProject(base, value, state.db ?? new Map());
  if (change.error !== undefined || change.description === undefined) {
    showStatus(change.error ?? "could not set the project", true);
    render();
    return;
  }
  setText(joinLines(setTask(lines, index, { description: change.description })));
  if (created) showStatus(`Added ${value} to projects.yml`, false);
}

// ---- plain view -------------------------------------------------------------

function renderPlain(): void {
  const area = byId("plain-text") as HTMLTextAreaElement;
  if (document.activeElement !== area && area.value !== state.text) area.value = state.text;
}

// The parsed day of the open file, for the viewer tab.
function publishCurrent(): void {
  if (shell && state.parse?.ok && state.name) {
    shell.current = { name: state.name, day: state.parse.day as unknown as TimeEntryDay };
  }
}

function render(): void {
  publishCurrent();
  byId("entries-section").classList.toggle("hidden", state.view !== "entries");
  byId("plain").classList.toggle("hidden", state.view !== "plain");
  byId("tab-entries").setAttribute("aria-pressed", String(state.view === "entries"));
  byId("tab-plain").setAttribute("aria-pressed", String(state.view === "plain"));
  renderStatus();
  if (state.view === "entries") renderEntries();
  else renderPlain();
}

// ---- mounting ---------------------------------------------------------------

// Mounts the editor in root.
export function mountEditor(root: HTMLElement, sharedShell: Shell): Controller {
  shell = sharedShell;
  api = sharedShell.api;
  scope = root;
  // After a sync or an import, the open file is read again, unless it has unsaved changes.
  sharedShell.onDataChanged(() => {
    void (async () => {
      state.files = await api.files();
      if (!state.name) return;
      if (dirty()) showStatus("The files changed on this device. Use Reload to see the new version.", true);
      else await open(state.name, true);
    })();
  });
  // A file picked in the viewer is opened here too, after the same check for unsaved changes.
  sharedShell.onSelectFile(() => {
    const name = sharedShell.selectedFile();
    if (!name || name === state.name) return;
    if (!confirmDiscard()) {
      sharedShell.selectFile(state.name);
      return;
    }
    void (async () => {
      await open(name, true);
      if (state.name && state.name !== name) sharedShell.selectFile(state.name); // could not open it
    })();
  });
  const controller: Controller = {
    show: () => {
      active = true;
    },
    hide: () => {
      active = false;
    },
  };
  root.innerHTML = EDITOR_TEMPLATE;

  const preferred = new URL(window.location.href).searchParams.get("name");
  wireFilePicker();
  byId("save").addEventListener("click", () => void save());
  byId("create-day").addEventListener("click", () => void createDay());
  (byId("new-day") as HTMLInputElement).value = localDate(new Date());
  byId("reload").addEventListener("click", () => void reload());
  byId("tab-entries").addEventListener("click", () => {
    state.view = "entries";
    render();
  });
  byId("filter-category").addEventListener("change", (event) => {
    state.filters.category = (event.target as HTMLSelectElement).value as CategoryFilter;
    render();
  });
  byId("filter-project").addEventListener("change", (event) => {
    state.filters.project = (event.target as HTMLSelectElement).value as ProjectFilter;
    render();
  });
  byId("tab-plain").addEventListener("click", () => {
    state.view = "plain";
    render();
  });
  const area = byId("plain-text") as HTMLTextAreaElement;
  area.addEventListener("input", () => setText(area.value));
  // Enter at the end of an entry adds the next entry, as the + button does in the entries view.
  // Enter anywhere else keeps the usual line break.
  area.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const caret = area.selectionStart;
    if (caret !== area.selectionEnd) return;
    const value = area.value;
    const lineEnd = value.indexOf("\n", caret);
    if ((lineEnd === -1 ? value.length : lineEnd) !== caret) return;
    const before = value.slice(0, caret).split("\n");
    const index = before.length - 1;
    const lines = splitLines(value);
    if (classify(lines[index]).kind !== "task") return;
    event.preventDefault();
    const parsed = entryAt(index);
    const next = insertAfter(lines, index, timeAfter(lines, index, parsed, new Date()));
    const text = joinLines(next);
    setText(text);
    area.value = text;
    const caretAt = lines.slice(0, index + 1).join("\n").length + 1 + next[index + 1].length;
    area.setSelectionRange(caretAt, caretAt);
  });
  window.addEventListener("keydown", (event) => {
    if (!active) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty()) event.preventDefault();
  });

  void (async () => {
    try {
      state.db = loadDatabase((await api.projects()).text, "projects.yml");
    } catch (err) {
      if (statusOf(err) !== 404) showStatus(`project database: ${errorText(err)}`, true);
    }
    try {
      state.vocabulary = await api.vocabulary();
    } catch {
      state.vocabulary = [];
    }
    await loadFiles(preferred);
    render();
  })();
  return controller;
}
