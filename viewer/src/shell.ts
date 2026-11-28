// The shared part of the page: where the data comes from, and what the tabs share. The operations
// come from an EditorApi: over HTTP when the Node server serves the page, or from the browser's
// own storage when the page is the installed web app.
import type { TimeEntryDay } from "@core/summary";
import { urlWithFile } from "@core/dayFiles";
import { EditorApi, StoreError } from "@core/workspace";

export type TabName = "editor" | "mobile" | "viewer" | "reports" | "fix" | "projects" | "settings";

export interface DayFile {
  name: string;
  text: string; // parser output as JSON
}

export interface DaysResult {
  files: DayFile[];
  errors: { name: string; message: string }[];
}

export interface DatabaseFile {
  text: string;
  hash: string;
}

// What each tab offers the page: it is shown or hidden, and may refresh when shown.
export interface Controller {
  show(): void;
  hide(): void;
}

export interface Shell {
  readonly api: EditorApi;
  // The day open in the editor, while it parses. The viewer shows it.
  current: { name: string; day: TimeEntryDay } | null;
  days(): Promise<DaysResult>;
  database(): Promise<DatabaseFile | null>;
  saveDatabase(text: string, base: string | null): Promise<{ hash: string }>;
  openTab(tab: TabName): void; // set by the page once the tabs exist
  // The day file chosen in the editor or the viewer. Both show it, and both are told when it changes.
  selectedFile(): string | null;
  selectFile(name: string): void;
  onSelectFile(listener: () => void): void;
  // Open a day file in the editor at a line (a link from Reports). The editor opens the file and shows the line.
  revealLine(name: string, line: number): void;
  onRevealLine(listener: (name: string, line: number) => void): void;
  // Day files or the database changed under the page (a sync or an import): tabs reload what they show.
  dataChanged(): void;
  onDataChanged(listener: () => void): void;
}

export function createShell(api: EditorApi): Shell {
  let selected: string | null = null;
  const listeners: (() => void)[] = [];
  const changeListeners: (() => void)[] = [];
  const revealListeners: ((name: string, line: number) => void)[] = [];
  return {
    api,
    current: null,
    selectedFile: () => selected,
    selectFile(name) {
      selected = name;
      try {
        history.replaceState(history.state, "", urlWithFile(location.href, name));
      } catch {
        // A page without history or a URL (a preview) still shows the file; only a refresh loses it.
      }
      // Listeners read selectedFile() rather than a value passed in, so a change made inside one
      // listener (the editor putting back the file it still has open) is seen by the rest.
      for (const listener of listeners) listener();
    },
    onSelectFile(listener) {
      listeners.push(listener);
    },
    revealLine(name, line) {
      for (const listener of revealListeners) listener(name, line);
    },
    onRevealLine(listener) {
      revealListeners.push(listener);
    },
    dataChanged() {
      for (const listener of changeListeners) listener();
    },
    onDataChanged(listener) {
      changeListeners.push(listener);
    },
    async days() {
      return api.days();
    },
    async database() {
      try {
        return await api.projects();
      } catch (err) {
        if (err instanceof StoreError && err.status === 404) return null;
        throw err;
      }
    },
    async saveDatabase(text, base) {
      return api.saveProjects(text, base);
    },
    openTab: () => undefined,
  };
}

