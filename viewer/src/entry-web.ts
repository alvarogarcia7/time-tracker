// The installed web app: the same page as make editor, over the browser's own storage, with the
// settings tab (sync, export and import) and the offline support.
import "./styles.css";
import { startPage } from "./app";
import { openLocal } from "./web/idb";
import { mountSettings } from "./web/settings";
import { loadSettings, registerOffline, requestPersistence, showNotice, syncNow } from "./web/host";

async function start(): Promise<void> {
  registerOffline();
  let opened;
  try {
    opened = await openLocal();
  } catch (err) {
    showNotice(`This browser cannot keep the days on this device: ${err instanceof Error ? err.message : String(err)}`, {
      dismiss: false,
    });
    return;
  }
  const { api, store } = opened;
  const shell = startPage(api, mountSettings(store));
  void requestPersistence();

  // Sync on open, and again when the connection comes back. iOS has no background sync, so the page
  // does it only while it is open.
  const sync = async () => {
    try {
      const result = await syncNow(store, shell);
      if (result.message.startsWith("Synced") || result.isError) showNotice(result.message);
    } catch (err) {
      showNotice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  window.addEventListener("online", () => void sync());
  try {
    if ((await loadSettings(store)).token) void sync();
  } catch (err) {
    showNotice(`Could not read the settings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void start();
