// The settings tab of the installed web app: the sync settings and token, the sync button, and the
// export and import of every day file and the project database.
import { BundleFile, makeBundle, parseBundle, planImport } from "@core/bundle";
import { fileStamp } from "@core/hash";
import type { Controller, Shell } from "../shell";
import type { SettingsMount } from "../app";
import { DATABASE_NAME, DEFAULT_DATABASE, IdbStore } from "./idb";
import { DEFAULT_REPO, loadSettings, showNotice, syncNow } from "./host";

const TEMPLATE = `
<h2 class="panel-title">Sync</h2>
<section class="card">
  <p class="muted small">
    Sync keeps the day files in your private data repository on GitHub, so your other devices get them too.
    The token is stored only in this browser. Use a fine-grained token that can read and write the contents
    of that one repository. Changes made offline are kept and sent when you are back online.
  </p>
  <div class="field-row">
    <label>GitHub owner <input id="set-owner" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label>Data repository <input id="set-repo" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
  </div>
  <div class="field-row">
    <label>Token <input id="set-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="paste the token"></label>
    <label>This device's name <input id="set-device" type="text" autocomplete="off" spellcheck="false"></label>
  </div>
  <div class="field-row">
    <button id="set-save" type="button" class="primary-button">Save settings</button>
    <button id="set-sync" type="button" class="button">Sync now</button>
    <button id="set-forget" type="button" class="button">Forget token</button>
  </div>
  <p id="set-status" class="small" role="status"></p>
</section>

<h2 class="panel-title">Project database copies</h2>
<section class="card">
  <p class="muted small">
    When an import differs from the project database on this device, the imported text is kept here as a copy.
    Move what you need into the Projects tab, then delete the copy.
  </p>
  <ul id="copies-list" class="share-list" aria-label="project database copies"></ul>
  <p id="copies-empty" class="muted small">No copies.</p>
</section>

<h2 class="panel-title">Backup</h2>
<section class="card">
  <p class="muted small">
    Export writes every day file and the project database to one JSON file. Keep a copy somewhere else.
    Import adds what is missing; a file whose text differs is never overwritten: its imported text is saved
    as a copy with a <code>.conflict-</code> name.
  </p>
  <div class="field-row">
    <button id="export-all" type="button" class="primary-button">Export backup</button>
    <button id="export-share" type="button" class="button hidden">Share backup</button>
  </div>
  <div id="export-files" class="served-list"></div>
  <div class="field-row">
    <label>Import a backup <input id="import-file" type="file" accept="application/json,.json"></label>
  </div>
  <p id="backup-status" class="small" role="status"></p>
</section>
`;


function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function mountSettings(store: IdbStore): SettingsMount {
  return (root: HTMLElement, shell: Shell): Controller => {
    root.innerHTML = TEMPLATE;
    const byId = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`) as T;
    const status = byId<HTMLElement>("set-status");
    const backupStatus = byId<HTMLElement>("backup-status");
    const ownerInput = byId<HTMLInputElement>("set-owner");
    const repoInput = byId<HTMLInputElement>("set-repo");
    const tokenInput = byId<HTMLInputElement>("set-token");
    const deviceInput = byId<HTMLInputElement>("set-device");
    const copiesList = byId<HTMLElement>("copies-list");
    const copiesEmpty = byId<HTMLElement>("copies-empty");
    let exported: Blob | null = null;
    let exportName = "";

    // The database copies, each with a delete button.
    const renderCopies = async () => {
      const { copies } = await store.exportRows();
      copiesList.replaceChildren();
      for (const copy of copies) {
        const item = document.createElement("li");
        item.className = "copy-row";
        const name = document.createElement("span");
        name.className = "share-name-text";
        name.textContent = copy.name;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "button";
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${copy.name}`);
        remove.addEventListener("click", async () => {
          if (!window.confirm(`Delete ${copy.name}? Its text is not in projects.yml.`)) return;
          await store.deleteDatabaseCopy(copy.name);
          await renderCopies();
          say(backupStatus, `Deleted ${copy.name}.`);
        });
        item.append(name, remove);
        copiesList.append(item);
      }
      copiesEmpty.classList.toggle("hidden", copies.length > 0);
    };

    const say = (node: HTMLElement, message: string, isError = false) => {
      node.textContent = message;
      node.classList.toggle("error", isError);
    };

    const fill = async () => {
      const settings = await loadSettings(store);
      ownerInput.value = settings.owner;
      repoInput.value = settings.repo;
      deviceInput.value = settings.device;
      tokenInput.value = "";
      tokenInput.placeholder = settings.token ? "a token is saved on this device" : "paste the token";
      byId<HTMLButtonElement>("set-forget").disabled = !settings.token;
    };

    byId<HTMLButtonElement>("set-save").addEventListener("click", async () => {
      const owner = ownerInput.value.trim();
      if (!owner) return say(status, "Enter the GitHub owner of the data repository.", true);
      await store.setSetting("owner", owner);
      await store.setSetting("repo", repoInput.value.trim() || DEFAULT_REPO);
      await store.setSetting("device", deviceInput.value.trim() || "device");
      if (tokenInput.value.trim()) await store.setSetting("token", tokenInput.value.trim());
      await fill();
      say(status, "Settings saved on this device.");
    });

    byId<HTMLButtonElement>("set-sync").addEventListener("click", async () => {
      say(status, "Syncing...");
      const result = await syncNow(store, shell);
      say(status, result.message, result.isError);
    });

    byId<HTMLButtonElement>("set-forget").addEventListener("click", async () => {
      await store.deleteSetting("token");
      await fill();
      say(status, "The token was forgotten on this device. Sync is off until a new token is saved.");
    });

    // ---- export ----------------------------------------------------------------------
    const prepareExport = async () => {
      const { days, projects, copies } = await store.exportRows();
      const toFile = (row: { name: string; text: string; updated: string }): BundleFile => ({
        name: row.name,
        text: row.text,
        updated: row.updated,
      });
      const now = new Date();
      const bundle = makeBundle(days.map(toFile), projects ? toFile(projects) : null, now, copies.map(toFile));
      exportName = `time-parser-export-${fileStamp(now)}.json`;
      exported = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const list = byId<HTMLElement>("export-files");
      list.replaceChildren();
      const rows = [...days, ...(projects ? [projects] : []), ...copies];
      for (const row of rows) {
        const link = document.createElement("a");
        link.className = "served-file";
        link.textContent = row.name;
        link.download = row.name;
        link.href = URL.createObjectURL(new Blob([row.text], { type: "text/plain" }));
        list.append(link);
      }
      byId<HTMLButtonElement>("export-share").classList.toggle(
        "hidden",
        !navigator.canShare?.({ files: [new File([exported], exportName, { type: "application/json" })] }),
      );
      return { count: rows.length };
    };

    byId<HTMLButtonElement>("export-all").addEventListener("click", async () => {
      const { count } = await prepareExport();
      if (exported) download(exportName, exported);
      say(backupStatus, `Exported ${count} file${count === 1 ? "" : "s"}. Each file can also be downloaded on its own below.`);
    });

    byId<HTMLButtonElement>("export-share").addEventListener("click", async () => {
      if (!exported) await prepareExport();
      if (!exported) return;
      try {
        await navigator.share({ files: [new File([exported], exportName, { type: "application/json" })], title: "Time parser backup" });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        say(backupStatus, "Sharing did not work here; use Export backup instead.", true);
      }
    });

    // ---- import ----------------------------------------------------------------------
    byId<HTMLInputElement>("import-file").addEventListener("change", async (event) => {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        const bundle = parseBundle(await file.text());
        const { days, projects, copies } = await store.exportRows();
        const localDays = new Map(days.map((row) => [row.name, row.text]));
        const localDatabases = new Map(
          [...(projects ? [projects] : []), ...copies].map((row) => [row.name, row.text] as const),
        );
        // The database a new device starts with is only a comment: an imported one replaces it.
        const untouched = projects === null || projects.text === DEFAULT_DATABASE;
        const now = new Date();
        const plan = planImport(bundle, localDays, localDatabases, now);
        const kept: string[] = [];
        let added = 0;
        let same = 0;
        for (const action of plan) {
          const replaces =
            action.kind === "conflict" && action.target === "database" && action.name === DATABASE_NAME && untouched;
          if (action.kind === "same") same += 1;
          else if (action.kind === "add" || replaces) {
            added += 1;
            if (action.target === "day") await store.createDay(action.name, action.text);
            else if (action.name === DATABASE_NAME) {
              const current = await store.readDatabase();
              if (current) await store.writeDatabase(action.text, current);
              else await store.putDatabaseCopy(DATABASE_NAME, action.text);
            } else await store.putDatabaseCopy(action.name, action.text);
          } else {
            kept.push(action.copy);
            if (action.target === "day") await store.createDay(action.copy, action.text);
            else await store.putDatabaseCopy(action.copy, action.text);
          }
        }
        shell.dataChanged();
        await renderCopies();
        const keptNote = kept.length
          ? ` ${kept.length} file${kept.length === 1 ? " differs" : "s differ"} from this device and ${kept.length === 1 ? "was" : "were"} saved as ${kept.join(", ")}.`
          : "";
        say(backupStatus, `Imported ${added} new, ${same} unchanged.${keptNote}`, kept.length > 0);
        if (kept.length) showNotice(`Import kept ${kept.length} conflicting copy${kept.length === 1 ? "" : "ies"}; see Settings.`);
      } catch (err) {
        say(backupStatus, `The backup was not imported: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    });

    void fill();
    void renderCopies();
    return {
      show: () => {
        void fill();
        void renderCopies();
      },
      hide: () => undefined,
    };
  };
}
