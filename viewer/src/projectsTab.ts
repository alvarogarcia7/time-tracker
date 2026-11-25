// The projects tab: the project database as a table, with a way to add a project and an editor
// for the whole file. Saving goes through the shell, which asks the server to check the text first.
import { Database, loadDatabase } from "@core/reports";
import type { Controller, Shell } from "./shell";

const TEMPLATE = `
<h2 class="panel-title">Projects</h2>
<div id="projects-status" class="muted small" role="status"></div>
<section class="card">
  <table class="project-table" aria-label="projects">
    <thead><tr><th>Project</th><th>Category</th><th>Keywords</th></tr></thead>
    <tbody id="projects-rows"></tbody>
  </table>
</section>
<section class="card">
  <h3 class="panel-title">Add a project</h3>
  <div class="field-row">
    <label>Name <input id="new-name" type="text" autocomplete="off"></label>
    <label>Category
      <select id="new-category">
        <option value="">none</option>
        <option value="personal">personal</option>
        <option value="professional">professional</option>
      </select>
    </label>
    <label>Keywords, comma-separated <input id="new-keywords" type="text" autocomplete="off"></label>
    <button id="add-project" type="button" class="primary-button">Add</button>
  </div>
</section>
<section class="card">
  <h3 class="panel-title">The whole file</h3>
  <textarea id="projects-text" class="database-text" spellcheck="false" aria-label="projects.yml"></textarea>
  <div class="field-row">
    <button id="projects-reload" type="button" class="button">Reload</button>
    <button id="projects-save" type="button" class="primary-button">Save</button>
  </div>
</section>
`;

// The YAML for one project, in the form the database accepts. Quoted, so any name or keyword is safe.
export function projectBlock(name: string, category: string, keywords: string[]): string {
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = [`${quote(name)}:`];
  if (category) lines.push(`  category: ${category}`);
  lines.push("  keywords:", ...keywords.map((word) => `    - ${quote(word)}`));
  return lines.join("\n") + "\n";
}

export function mountProjects(root: HTMLElement, shell: Shell): Controller {
  root.innerHTML = TEMPLATE;
  const byId = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`) as T;
  const status = byId<HTMLElement>("projects-status");
  const rows = byId<HTMLElement>("projects-rows");
  const text = byId<HTMLTextAreaElement>("projects-text");
  let hash: string | null = null;

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

  const renderRows = (db: Database) => {
    rows.replaceChildren(
      ...[...db.values()].map((project) => {
        const row = document.createElement("tr");
        const cells = [project.name, project.category ?? "uncategorised", project.keywords.join(", ")];
        for (const cell of cells) {
          const td = document.createElement("td");
          td.textContent = cell;
          row.append(td);
        }
        return row;
      }),
    );
  };

  const load = async (): Promise<void> => {
    try {
      const database = await shell.database();
      if (!database) {
        rows.replaceChildren();
        text.value = "";
        setStatus("No project database in this folder.");
        return;
      }
      hash = database.hash;
      text.value = database.text;
      try {
        renderRows(loadDatabase(database.text, "projects.yml"));
        setStatus(`${rows.children.length} project(s)`);
      } catch (err) {
        rows.replaceChildren();
        setStatus(err instanceof Error ? err.message : String(err), true);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  };

  const save = async (nextText: string): Promise<boolean> => {
    try {
      const saved = await shell.saveDatabase(nextText, hash);
      hash = saved.hash;
      setStatus("Saved projects.yml");
      await load();
      return true;
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
      return false;
    }
  };

  byId<HTMLButtonElement>("projects-reload").addEventListener("click", () => void load());
  byId<HTMLButtonElement>("projects-save").addEventListener("click", () => void save(text.value));
  byId<HTMLButtonElement>("add-project").addEventListener("click", async () => {
    const name = byId<HTMLInputElement>("new-name").value.trim();
    if (!name) return setStatus("Give the project a name.", true);
    const category = byId<HTMLSelectElement>("new-category").value;
    const keywords = byId<HTMLInputElement>("new-keywords")
      .value.split(",")
      .map((word) => word.trim())
      .filter(Boolean);
    const base = text.value.trim() ? text.value.replace(/\n*$/, "\n") + "\n" : "";
    if (await save(base + projectBlock(name, category, keywords.length ? keywords : [name]))) {
      byId<HTMLInputElement>("new-name").value = "";
      byId<HTMLInputElement>("new-keywords").value = "";
    }
  });

  return {
    show: () => void load(),
    hide: () => undefined,
  };
}
