// The files to fix tab: the day files that did not parse and the days with uncategorised entries, as
// links that open the day in the Editor.
import { loadDatabase, uncategorizedDetails } from "@core/reports";
import { dayLink } from "./reportsPanel";
import type { Controller, Shell } from "./shell";

export function mountFixFiles(root: HTMLElement, shell: Shell): Controller {
  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = "Files to fix";
  const list = document.createElement("ul");
  list.className = "fix-list";
  root.replaceChildren(title, list);

  const add = (name: string, reason: string, details: string[] = []) => {
    const item = document.createElement("li");
    const note = document.createElement("span");
    note.className = "muted small";
    note.textContent = ` ${reason}`;
    item.append(dayLink(shell, name), note);
    if (details.length) {
      const more = document.createElement("span");
      more.className = "muted reasons";
      more.textContent = details.slice(0, 4).join("; ") + (details.length > 4 ? `; and ${details.length - 4} more` : "");
      item.append(more);
    }
    list.append(item);
  };
  const message = (text: string) => {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = text;
    list.replaceChildren(item);
  };

  const refresh = async (): Promise<void> => {
    try {
      const days = await shell.days();
      const database = await shell.database();
      list.replaceChildren();
      const seen = new Set<string>();
      for (const error of days.errors) {
        if (!/\.md$/i.test(error.name)) continue;
        seen.add(error.name);
        add(error.name, `did not parse: ${error.message}`);
      }
      const db = database ? loadDatabase(database.text, "projects.yml") : null;
      for (const item of db ? uncategorizedDetails(days.files, db) : []) {
        if (!seen.has(item.name)) add(item.name, "has entries without a category:", item.reasons);
      }
      if (!list.children.length) message("Nothing to fix.");
    } catch (err) {
      message(`could not read the folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  shell.onDataChanged(() => void refresh());

  return { show: () => void refresh(), hide: () => undefined };
}
