// The parts of the installed web app that the editor page does not know about: the settings that
// the sync needs, the sync itself, the offline support (service worker), and the notice bar.
import { githubRepo } from "@core/github";
import { serialised } from "@core/serial";
import { syncDays, SyncOutcome } from "@core/sync";
import type { Shell } from "../shell";
import { IdbStore, syncLocal } from "./idb";

export const DEFAULT_REPO = "time-tracker-data";
export const OFFLINE_NOTE_KEY = "time-parser-offline-note-seen";

export interface Settings {
  owner: string;
  repo: string;
  token: string;
  device: string;
}

// Settings are in IndexedDB on this device. The token is never shown again once saved.
export async function loadSettings(store: IdbStore): Promise<Settings> {
  let device = await store.getSetting("device");
  if (!device) {
    const random = new Uint8Array(3);
    globalThis.crypto.getRandomValues(random);
    device = `device-${[...random].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    await store.setSetting("device", device);
  }
  return {
    owner: (await store.getSetting("owner")) ?? "",
    repo: (await store.getSetting("repo")) ?? DEFAULT_REPO,
    token: (await store.getSetting("token")) ?? "",
    device,
  };
}

export function describeOutcome(outcome: SyncOutcome): string {
  const sent = outcome.pushed.length;
  const received = outcome.pulled.length;
  const parts = [`Synced ${outcome.checked} file${outcome.checked === 1 ? "" : "s"}: ${sent} sent, ${received} received.`];
  if (outcome.removed.length) parts.push(`${outcome.removed.length} removed here because they were deleted on GitHub.`);
  if (outcome.deleted.length) parts.push(`${outcome.deleted.length} deleted on GitHub because they were deleted here.`);
  for (const conflict of outcome.conflicts) {
    parts.push(
      `${conflict.name} changed on two devices. The other version is the file; this device's version is kept as ${conflict.copy}.`,
    );
  }
  for (const error of outcome.errors) parts.push(`${error.name}: ${error.message}`);
  return parts.join(" ");
}

// Runs one sync when a token and an owner are saved. Offline, the changes stay on this device.
// Every failure, including a failed read of the settings, comes back as a message, never a rejection.
async function runSync(store: IdbStore, shell: Shell): Promise<{ message: string; isError: boolean }> {
  try {
    const settings = await loadSettings(store);
    if (!settings.token || !settings.owner) return { message: "Sync is off until you save the owner and a token in Settings.", isError: false };
    if (!navigator.onLine) return { message: "Offline: changes are kept on this device and sync when you are online.", isError: false };
    const remote = githubRepo({ owner: settings.owner, repo: settings.repo, token: settings.token });
    const outcome = await syncDays(syncLocal(store), remote, { device: settings.device, now: new Date() });
    if (outcome.pulled.length || outcome.conflicts.length || outcome.removed.length) shell.dataChanged();
    return { message: describeOutcome(outcome), isError: outcome.errors.length > 0 || outcome.conflicts.length > 0 };
  } catch (err) {
    return { message: `Sync failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// Every sync goes through one queue, so the open-time sync, the reconnect and the button never overlap.
const queue = serialised();
export function syncNow(store: IdbStore, shell: Shell): Promise<{ message: string; isError: boolean }> {
  return queue(() => runSync(store, shell));
}

// ---- the notice bar ----------------------------------------------------------------

export function showNotice(text: string, options: { action?: { label: string; run: () => void }; dismiss?: boolean } = {}): void {
  const bar = document.getElementById("app-notice");
  if (!bar) return;
  bar.replaceChildren();
  const message = document.createElement("span");
  message.textContent = text;
  bar.append(message);
  if (options.action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = options.action.label;
    button.addEventListener("click", options.action.run);
    bar.append(button);
  }
  if (options.dismiss !== false) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "button";
    close.textContent = "OK";
    close.addEventListener("click", () => bar.classList.add("hidden"));
    bar.append(close);
  }
  bar.classList.remove("hidden");
}

// ---- offline support ------------------------------------------------------------

// Registers the service worker where the browser allows it (https or localhost). When a new version
// is installed, the notice bar offers to reload.
export function registerOffline(): void {
  if (!("serviceWorker" in navigator)) return;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (location.protocol !== "https:" && !local) return;

  navigator.serviceWorker
    .register("./sw.js")
    .then((registration) => {
      const offer = (worker: ServiceWorker) => {
        showNotice("An update is available.", {
          action: {
            label: "Reload",
            run: () => worker.postMessage({ type: "SKIP_WAITING" }),
          },
        });
      };
      if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offer(worker);
        });
      });
    })
    .catch(() => undefined);

  // A page without a worker gets one on its first visit, and needs no reload for that. Only a
  // replaced worker (accepted in the notice bar) reloads the page.
  const hadController = navigator.serviceWorker.controller !== null;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

// Asks the browser to keep this site's data (iOS may otherwise clear it), once a device.
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // not available: the export is the backup
  }
  let seen = false;
  try {
    seen = localStorage.getItem(OFFLINE_NOTE_KEY) === "yes";
    if (!seen) localStorage.setItem(OFFLINE_NOTE_KEY, "yes");
  } catch {
    seen = true;
  }
  if (!seen) {
    showNotice("This app works offline on this device. Keep an export backup in Settings in case the browser clears its data.");
  }
}
