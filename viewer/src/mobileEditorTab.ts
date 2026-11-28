// The mobile editor: one day as a list of cards, and a bottom sheet to change or add an entry. It works on the
// same day files as the Editor tab, through the same api, and keeps the day text as the only source of truth.
import { chooseDayFile, dayWithWeekday, fileInUrl, localDay, newestFirst } from "@core/dayFiles";
import { classify, clockTime, removeLine, setTask, splitLines, joinLines, timeAfter, withProject } from "@core/editorModel";
import { addEntry, clockOfToken, durationLabel, frequentProjects, isReferenceLine, matchingProjects, normalizeStart, START_HELP } from "@core/mobileEditor";
import { Database, detectProjectInDb, loadDatabase } from "@core/reports";
import { colorsForProjects, UNKNOWN_PROJECT } from "@core/summary";
import { DayFileInfo, ParseResult, StoreError } from "@core/workspace";
import type { ParsedEntry } from "@core/parser";
import { dot, el } from "./dom";
import type { Controller, Shell } from "./shell";

const RELATIVE_CHIPS = ["-5", "-10", "-15", "+5", "+15"];

interface Draft {
  index: number | null; // the line of the entry, or null for a new one
  after?: number; // a new entry goes after this line; without it, at the end
  time: string;
  description: string;
  reference: string | null; // set when the line is a reference: the description the parser gave it
  original: { time: string; description: string }; // what the sheet opened with, to tell whether anything was typed
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function mountMobileEditor(root: HTMLElement, shell: Shell): Controller {
  const api = shell.api;
  let files: DayFileInfo[] = [];
  let name = "";
  let text = "";
  let saved = "";
  let base: string | null = null;
  let parse: ParseResult | null = null;
  let db: Database | null = null;
  let draft: Draft | null = null;
  let confirmingDelete = false;
  let notice: { text: string; bad: boolean } | null = null;
  let parseTicket = 0;
  let loaded = false;
  let opener: HTMLElement | null = null; // what had the focus before the sheet opened
  let seenSelection = shell.selectedFile(); // the Editor tab's day the last time this tab looked

  const dirty = () => text !== saved;

  // ---- the page -------------------------------------------------------------------------------------------
  const previous = button("‹", "m-icon", () => void step(1));
  previous.setAttribute("aria-label", "Older day");
  const next = button("›", "m-icon", () => void step(-1));
  next.setAttribute("aria-label", "Newer day");
  const dayButton = button("", "m-day", () => openDays());
  dayButton.setAttribute("aria-label", "Choose a day");
  const top = el("header", "m-top");
  top.append(previous, dayButton, next);

  const summary = el("p", "m-summary");
  const banner = el("div", "m-banner hidden");
  banner.setAttribute("role", "status");
  const list = el("ol", "m-list");
  const saveButton = button("Save", "m-save", () => void save());
  const addButton = button("+ Add entry", "m-add", () => openNew());
  const dock = el("div", "m-dock");
  dock.append(saveButton, addButton);

  // The sheet and its backdrop, used for the entry and for the list of days.
  const backdrop = el("div", "m-backdrop hidden");
  backdrop.addEventListener("click", () => {
    // A tap beside the sheet closes it; typed text is not thrown away without asking.
    const typed = draft !== null && (draft.time !== draft.original.time || draft.description !== draft.original.description);
    if (typed && !confirm("Throw away what you typed in this entry?")) return;
    closeSheet();
  });
  const sheet = el("div", "m-sheet hidden");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");

  const page = el("div", "m-page");
  page.append(top, summary, banner, list);
  root.replaceChildren(page, dock, backdrop, sheet);

  // ---- data -----------------------------------------------------------------------------------------------
  const entriesByLine = (): Map<number, ParsedEntry> => {
    const entries = parse ? (parse.ok ? parse.day.entries : parse.entries) : [];
    return new Map(entries.map((entry) => [entry.line, entry]));
  };

  async function loadDatabaseSafe(): Promise<void> {
    try {
      db = loadDatabase((await api.projects()).text, "projects.yml");
    } catch (err) {
      db = null;
      if (!(err instanceof StoreError && err.status === 404)) say(`project database: ${errorText(err)}`, true);
    }
  }

  async function parseNow(): Promise<void> {
    const ticket = ++parseTicket;
    const result = await api.parse(text);
    if (ticket !== parseTicket) return;
    parse = result;
    render();
  }

  async function open(file: string): Promise<void> {
    try {
      const read = await api.read(file);
      name = read.name;
      text = read.text;
      saved = read.text;
      base = read.hash;
      notice = null;
    } catch (err) {
      say(errorText(err), true);
      return;
    }
    await parseNow();
  }

  async function refresh(): Promise<void> {
    files = await api.files();
    await loadDatabaseSafe();
    // A day chosen in the Editor tab since the last look wins; otherwise the day open here stays.
    const selection = shell.selectedFile();
    const wanted = (selection !== seenSelection ? selection : null) || name || selection || fileInUrl(location.href);
    seenSelection = selection;
    const choice = chooseDayFile(files, wanted);
    if (!choice) {
      name = "";
      text = saved = "";
      parse = null;
      render();
      return;
    }
    await open(choice.name);
  }

  function say(message: string, bad: boolean): void {
    notice = { text: message, bad };
    render();
  }

  function setText(updated: string): void {
    text = updated;
    notice = null;
    render();
    void parseNow();
  }

  async function save(): Promise<void> {
    if (!dirty() || !name) return;
    saveButton.disabled = true;
    const sent = text;
    try {
      const written = await api.write(name, sent, base);
      saved = sent;
      base = written.hash;
      // The edits made while saving are not in this result: parse them again.
      if (text === sent) parse = written.parse;
      else void parseNow();
      say("Saved", false);
    } catch (err) {
      const conflict = err instanceof StoreError && err.status === 409;
      say(conflict ? `${errorText(err)}. Use ↻ to load the file on disk (this loses your changes).` : errorText(err), true);
    }
  }

  async function reload(): Promise<void> {
    if (dirty() && !confirm("Reload and lose the unsaved changes?")) return;
    await refresh();
  }

  async function switchTo(file: string): Promise<void> {
    if (file === name) return;
    if (dirty() && !confirm("Leave this day and lose the unsaved changes?")) return;
    await open(file);
  }

  // Older (1) or newer (-1) day, in the order of the day list.
  async function step(direction: number): Promise<void> {
    const ordered = newestFirst(files);
    const at = ordered.findIndex((file) => file.name === name);
    const target = ordered[at + direction];
    if (target) await switchTo(target.name);
  }

  // ---- the list -------------------------------------------------------------------------------------------
  function render(): void {
    const ordered = newestFirst(files);
    const at = ordered.findIndex((file) => file.name === name);
    const info = files.find((file) => file.name === name);
    dayButton.replaceChildren(el("strong", null, info?.date ? dayWithWeekday(info.date) : name || "No day"), el("small", null, name));
    previous.disabled = at < 0 || at >= ordered.length - 1;
    next.disabled = at <= 0;

    const entries = entriesByLine();
    const colors = colorsForProjects([...entries.values()].map((entry) => entry.project));
    const lines = splitLines(text);
    const rows = lines.map((line, index) => ({ index, line: classify(line) })).filter((row) => row.line.kind === "task");

    const closed = [...entries.values()].reduce((sum, entry) => sum + (entry.duration_minutes ?? 0), 0);
    summary.textContent = name
      ? `${durationLabel(closed) ?? "0m"} tracked · ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`
      : "";

    list.replaceChildren();
    if (name && !rows.length) list.append(el("li", "m-empty", "No entries yet. Tap Add entry to start."));
    if (!name) list.append(el("li", "m-empty", "No day files yet. Tap the date above to create one."));
    for (const row of rows) {
      if (row.line.kind !== "task") continue;
      const entry = entries.get(row.index + 1);
      const card = el("button", entry && entry.end === null ? "m-card open" : "m-card");
      card.type = "button";
      const times = el("span", "m-times");
      times.append(el("strong", null, entry?.start ?? (row.line.time || "—")));
      times.append(el("small", null, entry ? (entry.end ?? "open") : ""));
      const body = el("span", "m-body");
      body.append(el("span", "m-task", entry?.task || entry?.description || row.line.description || "(no description)"));
      const meta = el("span", "m-meta");
      const project = entry?.project;
      const known = project && project !== UNKNOWN_PROJECT;
      meta.append(dot(known ? colors.get(project) : undefined), el("span", "m-project", known ? project : "no project"));
      const length = durationLabel(entry?.duration_minutes ?? null);
      if (length) meta.append(el("span", "m-length", length));
      body.append(meta);
      card.append(times, body);
      card.setAttribute("aria-label", `Edit entry at ${entry?.start ?? row.line.time}`);
      card.addEventListener("click", () => openEdit(row.index));
      const item = el("li");
      item.append(card);
      list.append(item);
    }

    // An empty day (no entries yet) is not an error to show.
    const problem = parse && !parse.ok && rows.length ? parse : null;
    // The parser's message already starts with "line N:" for a line it names.
    const unsaved = dirty() && !problem && !notice;
    const message = unsaved ? "Not saved yet. Tap Save changes." : problem ? (/^line \d+/i.test(problem.error) ? problem.error.replace(/^line/, "Line") : `${problem.line ? `Line ${problem.line}: ` : ""}${problem.error}`) : (notice?.text ?? "");
    banner.textContent = message;
    banner.classList.toggle("hidden", !message);
    banner.classList.toggle("bad", Boolean(problem) || Boolean(notice?.bad));
    banner.classList.toggle("quiet", unsaved);

    saveButton.disabled = !dirty();
    saveButton.textContent = dirty() ? "Save changes" : "Saved";
    addButton.disabled = !name;
  }

  // ---- the sheet ------------------------------------------------------------------------------------------
  function closeSheet(): void {
    const wasOpen = !sheet.classList.contains("hidden");
    draft = null;
    confirmingDelete = false;
    sheet.classList.add("hidden");
    backdrop.classList.add("hidden");
    sheet.replaceChildren();
    document.body.classList.remove("m-locked");
    if (wasOpen && opener) (opener.isConnected ? opener : addButton).focus();
    opener = null;
  }

  function showSheet(label: string): void {
    if (sheet.classList.contains("hidden")) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.setAttribute("aria-label", label);
    sheet.classList.remove("hidden");
    backdrop.classList.remove("hidden");
    document.body.classList.add("m-locked");
  }

  function openEdit(index: number): void {
    const line = classify(splitLines(text)[index]);
    if (line.kind !== "task") return;
    const entry = entriesByLine().get(index + 1);
    const reference = entry && isReferenceLine(line.description, entry.description) ? entry.description : null;
    draft = { index, time: line.time, description: line.description, reference, original: { time: line.time, description: line.description } };
    renderEntrySheet();
  }

  function openNew(after?: number): void {
    const lines = splitLines(text);
    const entries = entriesByLine();
    const tasks = lines.map((line, index) => ({ index, kind: classify(line).kind })).filter((row) => row.kind === "task");
    const anchor = after ?? tasks[tasks.length - 1]?.index;
    const info = files.find((file) => file.name === name);
    const last = anchor === undefined ? undefined : entries.get(anchor + 1);
    // On a past day, an open last entry gives its own start (the new one follows it), not the clock now.
    const pastDay = Boolean(info?.date) && info?.date !== localDay(new Date());
    const time = anchor === undefined ? clockTime(new Date()) : pastDay && last && last.end === null ? last.start : timeAfter(lines, anchor, last, new Date());
    draft = { index: null, after, time, description: "", reference: null, original: { time, description: "" } };
    renderEntrySheet();
  }

  function currentProject(): { name: string | null; error?: string } {
    if (!draft) return { name: null };
    if (draft.reference !== null) {
      const entry = draft.index === null ? undefined : entriesByLine().get(draft.index + 1);
      return { name: entry && entry.project !== UNKNOWN_PROJECT ? entry.project : null };
    }
    if (!db) return { name: null };
    try {
      const found = detectProjectInDb(draft.description, db);
      return { name: found === UNKNOWN_PROJECT ? null : found };
    } catch (err) {
      return { name: null, error: errorText(err) };
    }
  }

  function renderEntrySheet(): void {
    const current = draft;
    if (!current) return;
    const creating = current.index === null;
    showSheet(creating ? "New entry" : "Edit entry");
    const locked = current.reference !== null;

    const handle = el("div", "m-handle");
    const title = el("h2", "m-sheet-title", creating ? "New entry" : "Edit entry");
    const close = button("✕", "m-icon m-close", () => closeSheet());
    close.setAttribute("aria-label", "Close without saving");
    const head = el("div", "m-sheet-head");
    head.append(title, close);

    // Start time: a text box for the notation of the file, the phone's time picker, and shortcuts.
    const timeInput = el("input", "m-input");
    timeInput.type = "text";
    timeInput.value = current.time;
    timeInput.autocomplete = "off";
    timeInput.setAttribute("autocapitalize", "none");
    timeInput.setAttribute("aria-label", "Start time");
    timeInput.placeholder = "08:30, 830 or 7.15";
    const picker = el("input", "m-picker");
    picker.type = "time";
    picker.value = clockOfToken(current.time);
    picker.setAttribute("aria-label", "Pick a time");
    const setTime = (value: string) => {
      current.time = value;
      timeInput.value = value;
      picker.value = clockOfToken(value);
    };
    timeInput.addEventListener("input", () => {
      current.time = timeInput.value.trim();
      picker.value = clockOfToken(current.time);
    });
    picker.addEventListener("change", () => {
      if (picker.value) setTime(picker.value);
    });
    const timeRow = el("div", "m-row");
    timeRow.append(timeInput, picker);
    const chips = el("div", "m-chips");
    chips.append(button("Now", "m-chip", () => setTime(clockTime(new Date()))));
    for (const chip of RELATIVE_CHIPS) chips.append(button(chip, "m-chip", () => setTime(chip)));
    const timeHint = el("p", "m-hint", "Type the time or pick it with the clock. -10 starts 10 minutes before the next entry; +5 starts 5 minutes after the previous one ends.");
    const timeField = el("div", "m-field");
    timeField.append(el("label", "m-label", "Starts at"), timeRow, chips, timeHint);

    // Description.
    const area = el("textarea", "m-input m-text");
    area.rows = 2;
    area.value = locked ? (current.reference ?? "") : current.description;
    area.disabled = locked;
    area.placeholder = "What did you do?";
    area.setAttribute("aria-label", "Description");
    const descriptionField = el("div", "m-field");
    descriptionField.append(el("label", "m-label", "Description"), area);
    if (!locked) descriptionField.append(el("p", "m-hint", "The project is kept as a tag at the end, after a comma."));
    if (locked) descriptionField.append(el("p", "m-hint", `This line points to another entry (${current.description}), so it uses that entry's text and project.`));

    // Project.
    const projectField = el("div", "m-field");
    projectField.append(el("span", "m-label", "Project"));
    const shown = el("div", "m-current");
    const chosen = el("div", "m-chips");
    const search = el("input", "m-input");
    search.type = "search";
    search.placeholder = "Find or add a project";
    search.autocomplete = "off";
    search.setAttribute("autocapitalize", "none");
    search.setAttribute("aria-label", "Find or add a project");
    search.disabled = locked || !db;
    const results = el("div", "m-results");
    const categoryChoice = el("select", "m-input");
    categoryChoice.setAttribute("aria-label", "Category of the new project");
    for (const [value, label] of [["", "Category: same as its parent"], ["personal", "Category: personal"], ["professional", "Category: professional"]]) {
      const option = el("option", null, label);
      option.value = value;
      categoryChoice.append(option);
    }

    const colors = colorsForProjects([...entriesByLine().values()].map((entry) => entry.project));
    const paintProject = () => {
      const project = currentProject();
      shown.replaceChildren();
      const known = project.name;
      shown.append(dot(known ? colors.get(known) : undefined), el("span", null, known ?? "No project yet"));
      if (project.error) shown.append(el("small", "m-warn", project.error));
    };
    async function choose(projectName: string, created: boolean): Promise<void> {
      if (!db || !draft) return;
      if (created) {
        try {
          await api.createProject(projectName, categoryChoice.value === "" ? undefined : (categoryChoice.value as "personal" | "professional"));
          await loadDatabaseSafe();
        } catch (err) {
          const message = errorText(err);
          paintResults(/overlaps keyword/.test(message) ? "A project with almost the same name exists (spaces and capitals do not count). Pick it from the list instead." : message);
          return;
        }
      }
      const change = withProject(area.value, projectName, db ?? new Map());
      if (change.description === undefined) {
        paintResults(change.error ?? "could not set the project");
        return;
      }
      draft.description = change.description;
      area.value = change.description;
      search.value = "";
      paintProject();
      paintResults();
    }
    function paintResults(problem?: string): void {
      results.replaceChildren();
      if (problem) results.append(el("p", "m-warn", problem));
      if (!db || locked) return;
      const typed = search.value.trim();
      const names = [...db.keys()];
      const found = typed ? matchingProjects(names, typed, 6) : [];
      for (const found_ of found) results.append(button(found_, "m-result", () => void choose(found_, false)));
      if (typed && !names.some((candidate) => candidate.toLowerCase() === typed.toLowerCase())) {
        results.append(categoryChoice, button(`Add “${typed}” as a new project`, "m-result add", () => void choose(typed, true)));
      }
    }
    const frequent = frequentProjects([...entriesByLine().values()], UNKNOWN_PROJECT, 6);
    if (!locked && db) {
      for (const projectName of frequent) chosen.append(button(projectName, "m-chip", () => void choose(projectName, false)));
    }
    search.addEventListener("input", () => paintResults());
    area.addEventListener("input", () => {
      current.description = area.value;
      paintProject();
    });
    paintProject();
    paintResults();
    projectField.append(shown, chosen, search, results);
    if (!db) projectField.append(el("p", "m-hint", "No project database loaded: add the project in the description, after a comma."));

    // Actions.
    const problem = el("p", "m-warn hidden");
    // The start time to write: as typed when it was not changed, otherwise in the form the files use.
    // Shows what is accepted and returns null when the text is not a time.
    const startToWrite = (): string | null => {
      const typed = current.time.trim();
      const kept = current.index !== null && typed === current.original.time.trim();
      const normal = kept ? typed : normalizeStart(typed);
      if (normal) return normal;
      problem.textContent = typed ? `“${typed}” is not a time. ${START_HELP}` : "Give the entry a start time.";
      problem.classList.remove("hidden");
      timeInput.focus();
      return null;
    };
    const done = button(creating ? "Add entry" : "Done", "m-primary", () => {
      const start = startToWrite();
      if (start === null) return;
      const lines = splitLines(text);
      if (current.index === null) {
        setText(joinLines(addEntry(lines, start, area.value.trim(), current.after).lines));
        if (current.after === undefined) list.lastElementChild?.scrollIntoView({ block: "nearest" });
      } else {
        const change = locked ? { time: start } : { time: start, description: area.value.trim() };
        setText(joinLines(setTask(lines, current.index, change)));
      }
      closeSheet();
    });
    const actions = el("div", "m-actions");
    actions.append(done);
    if (current.index !== null) {
      const index = current.index;
      const after = button("Add one after", "m-secondary", async () => {
        // Apply this entry's change first, so the new one starts where it ends.
        const start = startToWrite();
        if (start === null) return;
        const lines = splitLines(text);
        const change = locked ? { time: start } : { time: start, description: area.value.trim() };
        setText(joinLines(setTask(lines, index, change)));
        closeSheet();
        await parseNow(); // the end of this entry is read from the new parse
        openNew(index);
      });
      const remove = button("Delete", "m-danger", () => {
        if (!confirmingDelete) {
          confirmingDelete = true;
          remove.textContent = "Confirm delete";
          return;
        }
        setText(joinLines(removeLine(splitLines(text), index)));
        closeSheet();
      });
      actions.append(after, remove);
    }

    sheet.replaceChildren(handle, head, timeField, descriptionField, projectField, problem, actions);
    (creating ? area : timeInput).focus();
  }

  // The list of days, and a way to start a new one.
  function openDays(): void {
    showSheet("Days");
    const handle = el("div", "m-handle");
    const head = el("div", "m-sheet-head");
    const close = button("✕", "m-icon m-close", () => closeSheet());
    close.setAttribute("aria-label", "Close");
    head.append(el("h2", "m-sheet-title", "Days"), close);
    queueMicrotask(() => close.focus());

    const today = localDay(new Date());
    const hasToday = files.some((file) => file.date === today);
    const create = el("div", "m-field");
    const date = el("input", "m-input");
    date.type = "date";
    date.value = today;
    date.setAttribute("aria-label", "Date of a new day");
    const make = button("New day", "m-secondary", () => void createDay(date.value));
    const row = el("div", "m-row");
    row.append(date, make);
    create.append(el("label", "m-label", hasToday ? "Start another day" : "Start today"), row);

    const days = el("div", "m-days");
    for (const file of newestFirst(files)) {
      const label = file.date ? dayWithWeekday(file.date) : file.name;
      const item = button(label, file.name === name ? "m-day-item current" : "m-day-item", () => {
        closeSheet();
        void switchTo(file.name);
      });
      days.append(item);
    }
    sheet.replaceChildren(handle, head, create, days);
  }

  async function createDay(value: string): Promise<void> {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return;
    if (dirty() && !confirm("Leave this day and lose the unsaved changes?")) return;
    const [, year, month, day] = match;
    const file = `${value}.md`;
    try {
      await api.create(file, `${day}/${month}/${year}\n# Date, description, project:b:c\n- [ ] \n`);
    } catch (err) {
      if (!(err instanceof StoreError && err.status === 409)) {
        say(errorText(err), true);
        return;
      }
    }
    files = await api.files();
    closeSheet();
    await open(file);
  }

  // ---- the top bar's reload, and the tab ------------------------------------------------------------------
  const reloadButton = button("↻", "m-icon m-reload", () => void reload());
  reloadButton.setAttribute("aria-label", "Reload from storage");
  top.append(reloadButton);

  window.addEventListener("beforeunload", (event) => {
    if (dirty()) event.preventDefault();
  });
  // Escape closes the sheet, and Tab stays inside it. Nothing happens while no sheet is open.
  document.addEventListener("keydown", (event) => {
    if (sheet.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      closeSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(sheet.querySelectorAll<HTMLElement>("button, input, textarea")).filter((node) => !(node as HTMLButtonElement).disabled);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first) return;
    if (!sheet.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  shell.onDataChanged(() => {
    if (!dirty() && loaded) void refresh();
  });

  return {
    show: () => {
      // Read again when the tab opens, unless there are unsaved changes here.
      if (!dirty()) void refresh().then(() => (loaded = true));
      else loaded = true;
    },
    hide: () => closeSheet(),
  };
}
