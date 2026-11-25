// The settings tab of the installed web app: the sync settings and token, the sync button, and the
// export and import of every day file and the project database.
import { BundleFile, makeBundle, parseBundle, planImport } from "@core/bundle";
import { fileStamp } from "@core/hash";
import type { Controller, Shell } from "../shell";
import type { SettingsMount } from "../app";
import { DATABASE_NAME, DEFAULT_DATABASE, IdbStore } from "./idb";
import { DEFAULT_REPO, loadSettings, runSync, showNotice } from "./host";

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
    let exported: Blob | null = null;
    let exportName = "";

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
      const result = await runSync(store, shell);
      say(status, result.message, result.isError);
    });

    byId<HTMLButtonElement>("set-forget").addEventListener("click", async () => {
      await store.deleteSetting("token");
      await fill();
      say(status, "The token was forgotten on this device. Sync is off until a new token is saved.");
    });

    // ---- export ----------------------------------------------------------------------
    const prepareExport = async () => {
      const { days, projects } = await store.exportRows();
      const toFile = (row: { name: string; text: string; updated: string }): BundleFile => ({
        name: row.name,
        text: row.text,
        updated: row.updated,
      });
      const now = new Date();
      const bundle = makeBundle(days.map(toFile), projects ? toFile(projects) : null, now);
      exportName = `time-parser-export-${fileStamp(now)}.json`;
      exported = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const list = byId<HTMLElement>("export-files");
      list.replaceChildren();
      for (const row of [...days, ...(projects ? [projects] : [])]) {
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
      return { count: days.length + (projects ? 1 : 0) };
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
        const { days, projects } = await store.exportRows();
        const localDays = new Map(days.map((row) => [row.name, row.text]));
        const localDatabase = projects ? projects.text : null;
        // The database a new device starts with is only a comment: an imported one replaces it.
        const untouched = projects === undefined || projects === null || projects.text === DEFAULT_DATABASE;
        const now = new Date();
        const plan = planImport(bundle, localDays, localDatabase, now);
        const copies: string[] = [];
        let added = 0;
        let same = 0;
        for (const action of plan) {
          const replaces = action.kind === "conflict" && action.target === "database" && untouched;
          if (action.kind === "same") same += 1;
          else if (action.kind === "add" || replaces) {
            added += 1;
            if (action.target === "day") await store.createDay(action.name, action.text);
            else {
              const current = await store.readDatabase();
              if (current) await store.writeDatabase(action.text, current);
              else await store.putDatabaseCopy(DATABASE_NAME, action.text);
            }
          } else {
            copies.push(action.copy);
            if (action.target === "day") await store.createDay(action.copy, action.text);
            else await store.putDatabaseCopy(action.copy, action.text);
          }
        }
        shell.dataChanged();
        const conflictNote = copies.length
          ? ` ${copies.length} file${copies.length === 1 ? " differs" : "s differ"} from this device and ${copies.length === 1 ? "was" : "were"} saved as ${copies.join(", ")}.`
          : "";
        say(backupStatus, `Imported ${added} new, ${same} unchanged.${conflictNote}`, copies.length > 0);
        if (copies.length) showNotice(`Import kept ${copies.length} conflicting copy${copies.length === 1 ? "" : "ies"}; see Settings.`);
      } catch (err) {
        say(backupStatus, `The backup was not imported: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    });

    void fill();
    return {
      show: () => void fill(),
      hide: () => undefined,
    };
  };
}
