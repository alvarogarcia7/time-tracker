// The page: one shell with the tabs. Each tab is mounted once, and told when it is shown or hidden.
import { mountEditor } from "./editor/app";
import { mountFixFiles } from "./fixFilesTab";
import { mountMobileEditor } from "./mobileEditorTab";
import { mountProjects } from "./projectsTab";
import { mountReports } from "./reportsPanel";
import { createShell, Controller, Shell, TabName } from "./shell";
import { mountViewer } from "./viewerTab";
import type { EditorApi } from "@core/workspace";

const TABS: TabName[] = ["editor", "mobile", "viewer", "reports", "fix", "projects", "settings"];

// The settings tab exists only where the page has the browser's storage (the installed web app).
export type SettingsMount = (root: HTMLElement, shell: Shell) => Controller;

function isTab(value: string): value is TabName {
  return (TABS as string[]).includes(value);
}

export function startPage(api: EditorApi, settings?: SettingsMount): Shell {
  const shell = createShell(api);
  const available = TABS.filter((tab) => tab !== "settings" || settings !== undefined);
  if (!settings) {
    document.querySelector('[data-tab="settings"][role="tab"]')?.remove();
    document.getElementById("panel-settings")?.remove();
  }

  const panel = (tab: TabName) => document.getElementById(`panel-${tab}`) as HTMLElement;
  const controllers: Record<TabName, Controller> = {
    editor: mountEditor(panel("editor"), shell),
    mobile: mountMobileEditor(panel("mobile"), shell),
    viewer: mountViewer(panel("viewer"), shell),
    reports: mountReports(panel("reports"), shell),
    fix: mountFixFiles(panel("fix"), shell),
    projects: mountProjects(panel("projects"), shell),
    settings: settings ? settings(panel("settings"), shell) : { show: () => undefined, hide: () => undefined },
  };

  let current: TabName | null = null;
  // Opening another tab adds a history entry, so the back button returns to the previous tab. Showing the
  // same tab again, the first tab shown and a tab shown by the back or forward button only replace it.
  const select = (tab: TabName, record = true) => {
    const changed = current !== null && current !== tab;
    if (current !== null && current !== tab) controllers[current].hide();
    current = tab;
    for (const name of available) {
      const showing = name === tab;
      panel(name).classList.toggle("hidden", !showing);
      document.querySelector(`[data-tab="${name}"][role="tab"]`)?.setAttribute("aria-selected", String(showing));
    }
    // The tab goes in the hash; the file in ?name= stays, so a refresh opens it again.
    const url = `${location.pathname}${location.search}#${tab}`;
    if (record && changed) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    controllers[tab].show();
  };
  shell.openTab = select;

  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))) {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab ?? "";
      if (isTab(tab)) select(tab);
    });
  }

  const tabInHash = (): TabName => {
    const fromHash = window.location.hash.slice(1);
    return isTab(fromHash) && (available as string[]).includes(fromHash) ? fromHash : "editor";
  };
  window.addEventListener("popstate", () => select(tabInHash(), false));
  select(tabInHash());
  return shell;
}
