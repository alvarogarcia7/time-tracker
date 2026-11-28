// The web editor page: a plain text view, and an entries view with dropdowns.
import { chooseDayFile, dayWithWeekday, localDay, shortcutFiles } from "@core/dayFiles";
import { formatMinutes, UNKNOWN_PROJECT } from "@core/summary";
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
  insertForTyping,
  endChangeNotice,
  noDayFileNotice,
  addEntryLabel,
  PROJECT_PLACEHOLDER,
  lineAnnotations,
  timeCellText,
  TIME_HEADER_HINT,
  reloadPrompt,
  deleteConfirmation,
  nextDayAfter,
  savedMessage,
  isUnsaved,
  statusLead,
  joinLines,
  timeAfter,
  removeLine,
  setLine,
  setTask,
  splitLines,
  verifyProjectChange,
  withProject,
} from "@core/editorModel";
import { matchingProjects } from "@core/mobileEditor";

interface FileInfo {
  name: string;
  hash: string;
  date: string | null;
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

type ParseResult =
  | { ok: true; day: { entries: DayEntry[]; tag: string | null } }
  | { ok: false; error: string; line: number | null; entries: DayEntry[] };

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

// A cell box holds typed text that is not committed yet (set on each keystroke, cleared on commit or discard).
let typedPending = false;

// Tab and Enter in a cell move to the next field of the row, in this order.
const CELL_ORDER = ["time", "description", "project", "add"];
// The field that gets focus when the table is drawn again: a commit redraws the table.
let focusAfterRender: { line: number; column: string } | null = null;

// The target is kept while focus is lost (the page or a removed box has it): a parse redraws the table
// a moment after a commit. Focus on anything else ends it.
function restoreFocus(): void {
  const target = focusAfterRender;
  if (!target) return;
  const cell = state.view === "entries" ? byId("entries").querySelector<HTMLElement>(`tr[data-line="${target.line}"] [data-col="${target.column}"]`) : null;
  const field = cell ? cell.querySelector<HTMLElement>("input") ?? cell : null;
  const active = document.activeElement;
  if (!field || (active && active !== document.body && active !== field)) {
    focusAfterRender = null;
    return;
  }
  field.focus();
}

function dirty(): boolean {
  return isUnsaved(state.text, state.saved, typedPending);
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
  // The shortcuts come first, then the files. A shortcut with no file (no file for today) is greyed out.
  let shown: PickerOption[] = [];
  let highlight = -1;
  let navigated = false;

  const hide = () => {
    list.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    highlight = -1;
  };
  const paint = () => Array.from(list.children).forEach((node, index) => node.classList.toggle("active", index === highlight));
  // The next enabled option from index in direction step (1 or -1), wrapping around; -1 when none is enabled.
  const nextEnabled = (from: number, step: number): number => {
    for (let count = 1; count <= shown.length; count++) {
      const index = (from + step * count + shown.length * count) % shown.length;
      if (!shown[index].disabled) return index;
    }
    return -1;
  };

  let choosing = false; // set while a file is being chosen, so the blur below does not report a name

  const choose = (name: string) => {
    hide();
    state.notice = null; // a message from a failed typed name no longer applies
    renderStatus();
    choosing = true;
    input.blur();
    choosing = false;
    if (name === state.name) setFileInput(state.name);
    else void open(name);
  };

  const refresh = (showAll: boolean) => {
    const typed = showAll ? "" : input.value.trim().toLowerCase();
    shown = pickerOptions(new Date()).filter((option) => !typed || option.label.toLowerCase().includes(typed));
    list.replaceChildren();
    for (const option of shown) {
      const item = el("li", option.disabled ? "suggestion disabled" : "suggestion");
      item.append(option.label);
      if (option.detail) item.append(el("span", "muted", ` ${option.detail}`));
      item.setAttribute("role", "option");
      item.setAttribute("aria-disabled", String(option.disabled));
      item.addEventListener("mousedown", (event) => {
        event.preventDefault(); // keep the focus until the file is chosen
        if (!option.disabled && option.file) choose(option.file);
      });
      list.append(item);
    }
    highlight = nextEnabled(-1, 1);
    navigated = false;
    list.classList.toggle("hidden", shown.length === 0);
    input.setAttribute("aria-expanded", String(shown.length > 0));
    paint();
  };

  // The files the list shows for the typed text (shortcuts count when they name a file).
  const matchingFiles = () => shown.filter((option) => option.file !== null).length;

  input.addEventListener("focus", () => {
    input.select();
    refresh(true);
  });
  input.addEventListener("input", () => refresh(false));
  input.addEventListener("blur", () => {
    hide();
    // Tab on a name that matches no file: the box goes back to the open file, and says why.
    const notice = !choosing && input.value.trim() !== state.name ? noDayFileNotice(input.value, matchingFiles()) : null;
    setFileInput(state.name);
    if (notice) showStatus(notice, true);
  });
  input.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      const next = nextEnabled(highlight < 0 ? -1 : highlight, event.key === "ArrowDown" ? 1 : -1);
      if (next >= 0) {
        highlight = next;
        navigated = true;
        paint();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const typed = input.value.trim().toLowerCase();
      const enabled = shown.filter((option) => !option.disabled);
      const exact = shown.find((option) => option.label.toLowerCase() === typed);
      const only = enabled.length === 1 ? enabled[0] : undefined;
      const pick = exact ?? only ?? (navigated && highlight >= 0 ? shown[highlight] : undefined);
      if (pick?.file && !pick.disabled) choose(pick.file);
      else {
        const notice = noDayFileNotice(input.value, matchingFiles());
        setFileInput(state.name);
        if (notice) showStatus(notice, true);
      }
    } else if (event.key === "Escape") {
      setFileInput(state.name);
      input.blur();
    }
  });
}

// What the picker offers: the last file and today's file (greyed out when there is none), then every file.
interface PickerOption {
  label: string;
  detail: string | null; // the file the shortcut names, shown beside it
  file: string | null;
  disabled: boolean;
}

function pickerOptions(now: Date): PickerOption[] {
  const { last, today } = shortcutFiles(state.files, localDay(now));
  const shortcuts: PickerOption[] = [
    { label: "Last file", detail: last?.name ?? null, file: last?.name ?? null, disabled: last === undefined },
    { label: "Today", detail: today?.name ?? "no file for today", file: today?.name ?? null, disabled: today === undefined },
  ];
  const files = state.files.map((file) => ({ label: file.name, detail: file.date ? dayWithWeekday(file.date) : null, file: file.name, disabled: false }));
  return [...shortcuts, ...files];
}

// ---- loading and saving -----------------------------------------------------

async function loadFiles(preferred: string | null): Promise<void> {
  state.files = await api.files();
  // The file named in the URL, else the newest day; open() puts the choice in the URL.
  const first = chooseDayFile(state.files, preferred);
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
  typedPending = false; // a cell box of the file before this one is gone
  state.saved = file.text;
  state.notice = null; // a message about the file before this one no longer applies
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
  const message = savedMessage(state.parse);
  showStatus(message.text, message.isError);
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
  let message: string;
  try {
    await api.create(name, `${day}/${month}/${year}\n# Date, description, project:b:c\n- [ ] \n`);
    message = `Created ${name}.`;
  } catch (err) {
    if (statusOf(err) !== 409) {
      showStatus(errorText(err), true);
      return;
    }
    message = `${name} already exists; it is open below.`;
  }
  state.files = await api.files();
  await open(name, true);
  // Shown after the open, which clears the notice about the file before it. If the open failed, its error stays.
  if (state.name === name) showStatus(message, false);
}

// YYYY-MM-DD in the local time zone, the value of a date input.
export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function reload(): Promise<void> {
  if (dirty() && !window.confirm(reloadPrompt(state.name))) return;
  await open(state.name, true);
}

// Deletes the open day file (and its JSON, when there is one) after a confirmation. Both are kept as
// backups. The page then shows the next file, or none, and the viewer's day list is read again.
async function deleteDay(): Promise<void> {
  const name = state.name;
  if (!name || !window.confirm(deleteConfirmation(name, dirty()))) return;
  try {
    await api.delete(name, state.base);
  } catch (err) {
    const note = statusOf(err) === 409 ? " Use Reload to see the file on disk." : "";
    showStatus(`${errorText(err)}${note}`, true);
    return;
  }
  // The open file is cleared before the viewer is told, so the change listener below does not read it again.
  state.name = "";
  state.files = await api.files();
  shell?.dataChanged();
  // The deleted name goes back into the sorted list, so the next file is the one that followed it.
  const next = nextDayAfter([...state.files.map((file) => file.name), name].sort(), name);
  if (next) {
    await open(next, true);
    showStatus(`Deleted ${name}.`, false);
  } else {
    state.text = "";
    state.saved = "";
    state.base = "";
    state.parse = null;
    state.good = [];
    state.notice = null;
    setFileInput("");
    shell?.selectFile("");
    render();
    showStatus(`Deleted ${name}. No day files are left in this folder.`, false);
  }
}

// ---- parsing and editing ------------------------------------------------------

function scheduleParse(): void {
  window.clearTimeout(parseTimer);
  parseTimer = window.setTimeout(() => void parseNow(), 250);
}

// The entry above an edited row, and its end before the edit; checked when the next parse arrives.
let endWatch: { line: number; end: string | null } | null = null;

// Before a row is deleted or re-timed: the entry above it, whose end the edit can change.
function watchEndAbove(lines: readonly string[], index: number): void {
  let above = index - 1;
  while (above >= 0 && classify(lines[above]).kind !== "task") above -= 1;
  const entry = above >= 0 ? entryAt(above) : undefined;
  endWatch = entry ? { line: above + 1, end: entry.end } : null;
}

async function parseNow(): Promise<void> {
  try {
    state.parse = (await api.parse(state.text)) as unknown as ParseResult;
    if (state.parse.ok) state.good = state.parse.day.entries;
  } catch (err) {
    showStatus(errorText(err), true);
  }
  const watch = endWatch;
  endWatch = null;
  const after = watch && state.parse?.ok ? state.parse.day.entries.find((entry) => entry.line === watch.line) : undefined;
  const notice = watch && after ? endChangeNotice(watch.line, watch.end, after.end) : null;
  if (notice) showStatus(notice, false);
  render();
}

// Every edit goes through here, so the text, the status and both views stay in step.
function setText(text: string): void {
  state.text = text;
  state.notice = null;
  scheduleParse();
  render();
}

// The computed start and end of each line: all of them when the whole file parses, otherwise
// the lines above the first error.
function entryAt(index: number): DayEntry | undefined {
  if (!state.parse) return undefined;
  const entries = state.parse.ok ? state.parse.day.entries : state.parse.entries;
  return entries.find((entry) => entry.line === index + 1);
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
  const parts = statusLead(dirty(), state.parse !== null && !state.parse.ok);
  if (state.notice) {
    node.textContent = state.notice.text;
    node.classList.toggle("error", state.notice.isError);
  } else if (state.parse?.ok) {
    const minutes = state.parse.day.entries.reduce((sum, entry) => sum + (entry.duration_minutes ?? 0), 0);
    parts.push(`${state.parse.day.entries.length} entries, ${formatMinutes(minutes)} tracked`);
    node.textContent = parts.join(" · ");
    node.classList.remove("error");
  } else if (state.parse) {
    node.textContent = [...parts, `parse error: ${state.parse.error}`].join(" · ");
    node.classList.add("error");
  } else {
    node.textContent = parts.join(" · ");
    node.classList.remove("error");
  }
  (byId("save") as HTMLButtonElement).disabled = !dirty();
  (byId("delete") as HTMLButtonElement).disabled = !state.name;
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
  let finished = false;

  const finish = (next: string | null) => {
    if (finished) return;
    finished = true;
    typedPending = false;
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
    list.classList.toggle("hidden", shown.length === 0);
    placeList();
    paint();
  };

  // The entries box scrolls sideways, which would clip a list that opens downwards. An open list is placed
  // on the page under its box, or above it when there is no room below.
  const placeList = () => {
    if (shown.length === 0) return;
    const box = input.getBoundingClientRect();
    const height = Math.min(list.scrollHeight, 240);
    const below = box.bottom + height + 2 <= window.innerHeight;
    list.style.position = "fixed";
    list.style.left = `${box.left}px`;
    list.style.minWidth = `${Math.max(box.width, 160)}px`;
    list.style.top = `${below ? box.bottom + 2 : Math.max(0, box.top - height - 2)}px`;
  };

  input.addEventListener("focus", refresh);
  input.addEventListener("input", () => {
    refresh();
    typedPending = input.value !== value;
    renderStatus();
  });
  // Leaving the box commits only what is already a choice: the value as it was, or an existing name.
  // A half-typed name (TLS while client-a:TLS is listed) is dropped, not created as a new project.
  input.addEventListener("blur", () => {
    const typed = input.value.trim();
    const known = [...new Set(options())].find((option) => option.toLowerCase() === typed.toLowerCase());
    finish(known ?? (typed === value ? typed : null));
  });
  input.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      highlight = (highlight + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      paint();
    } else if (event.key === "Enter") {
      // Enter takes the exact name, else the highlighted suggestion, else the typed text (a new name).
      event.preventDefault();
      const typed = input.value.trim();
      const exact = shown.find((option) => option.toLowerCase() === typed.toLowerCase());
      finish(exact ?? (shown.length && highlight >= 0 ? shown[highlight] : typed));
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
    const th = el("th", null, label);
    if (label === "Time") th.title = TIME_HEADER_HINT;
    head.append(th);
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
      input.addEventListener("input", () => {
        typedPending = input.value.trim() !== line;
        renderStatus();
      });
      input.addEventListener("change", () => {
        typedPending = false;
        setText(joinLines(setLine(lines, index, input.value.trim())));
      });
      cell.append(input);
      // A bad header is the line that failed: its error shows here, and no entry row is marked.
      if (state.parse?.ok === false && state.parse.line === index + 1) cell.append(el("div", "error small", state.parse.error));
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
    body.append(entryRow(lines, index, timeCellText(parsed.time, entryAt(index)?.start ?? null), parsed.description));
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
  const failed = state.parse?.ok === false && state.parse.line === index + 1 ? state.parse : null;
  const row = el("tr", failed ? "unparsed" : null); // only the line that failed is marked
  row.dataset.line = String(index);
  row.addEventListener(
    "keydown",
    (event) => {
      if ((event.key !== "Tab" && event.key !== "Enter") || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const field = event.target;
      const column = field instanceof HTMLElement ? field.closest<HTMLElement>("td")?.dataset.col : undefined;
      const next = column ? CELL_ORDER[CELL_ORDER.indexOf(column) + 1] : undefined;
      if (!(field instanceof HTMLInputElement) || !next) return;
      focusAfterRender = { line: index, column: next };
      // Tab leaves the box through blur, which commits as it does today; the focus then goes to the next field.
      if (event.key === "Tab") {
        event.preventDefault();
        field.blur();
      }
    },
    true,
  );
  row.append(el("td", "muted", String(index + 1)));
  row.append(el("td", null, entry?.start ?? "-"));
  // An open end means the last entry of a file that parses; above an error the end is unknown.
  row.append(el("td", null, entry ? entry.end ?? (state.parse?.ok ? "open" : "-") : "-"));

  const timeCell = el("td");
  timeCell.dataset.col = "time";
  timeCell.append(
    combobox(time, timeOptions, (value) => {
      watchEndAbove(lines, index);
      setText(setTask(lines, index, { time: value }).join("\n"));
    }),
  );
  row.append(timeCell);

  const descriptionCell = el("td");
  descriptionCell.dataset.col = "description";
  descriptionCell.append(
    combobox(description, descriptionOptions, (value) =>
      setText(setTask(lines, index, { description: value }).join("\n")),
    ),
  );
  if (entry?.reference) descriptionCell.append(el("div", "muted small", `copies ${entry.description}`));
  if (failed) descriptionCell.append(el("div", "error small", failed.error));
  row.append(descriptionCell);

  const projectTd = projectCell(lines, index, description);
  projectTd.dataset.col = "project";
  row.append(projectTd);
  row.append(el("td", "num", entry?.duration_minutes === null || !entry ? "-" : formatMinutes(entry.duration_minutes)));

  const actions = el("td", "actions");
  const add = el("button", null, addEntryLabel);
  add.type = "button";
  add.title = "add an entry after this one, starting when this one ends";
  add.dataset.col = "add";
  // A press keeps the cell focused, so the blur does not redraw the table before the click arrives.
  add.addEventListener("mousedown", (event) => event.preventDefault());
  add.addEventListener("click", () => {
    focusAfterRender = { line: index + 1, column: "time" };
    setText(joinLines(insertAfter(lines, index, timeAfter(lines, index, entry, new Date()))));
  });
  const remove = el("button", null, "×");
  remove.type = "button";
  remove.title = "delete this entry";
  remove.addEventListener("click", () => {
    watchEndAbove(lines, index);
    setText(joinLines(removeLine(lines, index)));
  });
  actions.append(add, remove);
  row.append(actions);
  return row;
}

function projectCell(lines: string[], index: number, description: string): HTMLElement {
  const cell = el("td", "project-cell");
  const { project, error } = projectOf(entryAt(index)?.description ?? description);
  // An entry without a project has an empty cell (the placeholder), not the word "unknown".
  const current = project === UNKNOWN_PROJECT ? "" : project;
  if (error) cell.title = error;
  const combo = combobox(
    current,
    () => (state.db ? [...state.db.keys()] : []),
    (value) => void chooseProject(lines, index, value),
  );
  const input = combo.querySelector("input") as HTMLInputElement;
  if (!current) input.placeholder = PROJECT_PLACEHOLDER;
  combo.append(el("span", "caret", "\u25BE"));
  // A click anywhere in the cell focuses the box, which opens the list.
  cell.addEventListener("click", (event) => {
    if (event.target !== input) input.focus();
  });
  cell.append(combo);
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
  if (created) {
    // A name typed in the cell is a new project: ask first, naming the projects it may have been meant for.
    const similar = matchingProjects([...(state.db?.keys() ?? [])], value, 3);
    const hint = similar.length ? ` Did you mean ${similar.join(", ")}?` : "";
    if (!confirm(`Add “${value}” as a new project?${hint}`)) {
      render();
      return;
    }
  }
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
  // Checked before it is applied: only this line changes, and it shows the chosen project.
  const next = setTask(lines, index, { description: change.description });
  const problem = verifyProjectChange(lines, next, index, value, state.db ?? new Map());
  if (problem !== null) {
    showStatus(`Not changed: ${problem}`, true);
    render();
    return;
  }
  setText(joinLines(next));
  if (created) showStatus(`Added ${value}`, false);
}

// ---- plain view -------------------------------------------------------------

function renderPlain(): void {
  const area = byId("plain-text") as HTMLTextAreaElement;
  if (document.activeElement !== area && area.value !== state.text) area.value = state.text;
  renderLineSides();
}

// The line number and the project of each line, beside the textarea. Rebuilt from the text on each change.
function renderLineSides(): void {
  const entries = state.parse ? (state.parse.ok ? state.parse.day.entries : state.parse.entries) : [];
  const rows = lineAnnotations(state.text, state.db, entries);
  const numbers = byId("plain-numbers");
  const projects = byId("plain-projects");
  numbers.replaceChildren(...rows.map((row) => el("div", null, String(row.number))));
  projects.replaceChildren(
    ...rows.map((row) => {
      const cell = el("div", null, row.project);
      if (row.error) cell.title = row.error;
      return cell;
    }),
  );
  syncLineSides();
}

// The side columns scroll with the textarea.
function syncLineSides(): void {
  const scrollTop = (byId("plain-text") as HTMLTextAreaElement).scrollTop;
  byId("plain-numbers").scrollTop = scrollTop;
  byId("plain-projects").scrollTop = scrollTop;
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
  restoreFocus();
}

// Opens a file at a line, in the plain text view, with the line selected.
async function reveal(name: string, line: number): Promise<void> {
  if (name !== state.name) {
    if (!confirmDiscard()) return;
    await open(name, true);
    if (state.name !== name) return; // could not open it
  }
  state.view = "plain";
  render();
  const lines = state.text.split("\n");
  const start = lines.slice(0, Math.max(0, line - 1)).reduce((sum, text) => sum + text.length + 1, 0);
  const area = byId("plain-text") as HTMLTextAreaElement;
  area.focus();
  area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
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
  // A link from Reports: the file opens (after the usual check for unsaved changes) with the line shown.
  sharedShell.onRevealLine((name, line) => void reveal(name, line));
  const controller: Controller = {
    show: () => {
      active = true;
      // The projects may have changed on the Projects tab (or by a sync) since this tab was last shown.
      void (async () => {
        try {
          state.db = loadDatabase((await api.projects()).text, "projects.yml");
          render();
        } catch {
          // No database, or one that does not load: the list keeps what it had.
        }
      })();
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
  byId("delete").addEventListener("click", () => void deleteDay());
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
  area.addEventListener("scroll", syncLineSides);
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
    const next = insertForTyping(lines, index, timeAfter(lines, index, parsed, new Date()));
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

