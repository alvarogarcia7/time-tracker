// The browser's storage: the day files, the project database, their old versions, the sync state
// and the settings, in one IndexedDB database on this device. It implements the same Storage
// contract as the Node disk storage, so DayService behaves the same in both.
import { sha256Hex } from "@core/hash";
import type { SyncedState, SyncLocal } from "@core/sync";
import { DatabaseFile, DayFile, DayFileInfo, DayService, Storage } from "@core/workspace";

const DB_NAME = "time-parser";
const DB_VERSION = 1;
export const DATABASE_NAME = "projects.yml";
export const DEFAULT_DATABASE = "# Project database: one block per project, with an optional category and its keywords.\n";

export interface StoredText {
  name: string;
  text: string;
  updated: string;
}

export interface StoredBackup {
  id?: number;
  name: string;
  text: string;
  savedAt: string;
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("days", { keyPath: "name" });
      db.createObjectStore("database", { keyPath: "name" });
      db.createObjectStore("backups", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("sync", { keyPath: "name" });
      db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser storage could not be opened"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One read-write transaction. The work runs at once, so its requests belong to the transaction.
function transact(db: IDBDatabase, stores: string[], work: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("the change was not saved"));
    work(tx);
  });
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class IdbStore implements Storage {
  readonly databaseLabel = DATABASE_NAME;

  constructor(readonly db: IDBDatabase) {}

  private now(): string {
    return new Date().toISOString();
  }

  async listDays(): Promise<DayFileInfo[]> {
    const rows = await request<StoredText[]>(this.db.transaction("days").objectStore("days").getAll());
    return Promise.all(
      rows.sort(byName).map(async (row) => ({ name: row.name, hash: await sha256Hex(row.text) })),
    );
  }

  async readDay(name: string): Promise<DayFile | null> {
    const row = await request<StoredText | undefined>(this.db.transaction("days").objectStore("days").get(name));
    if (!row) return null;
    return { name, text: row.text, hash: await sha256Hex(row.text) };
  }

  async writeDay(name: string, text: string, previous: DayFile): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    const savedAt = this.now();
    await transact(this.db, ["days", "backups"], (tx) => {
      tx.objectStore("days").put({ name, text, updated: savedAt } satisfies StoredText);
      if (previous.text !== text) {
        tx.objectStore("backups").add({ name, text: previous.text, savedAt } satisfies StoredBackup);
      }
    });
    return { hash };
  }

  async createDay(name: string, text: string): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    await transact(this.db, ["days"], (tx) => {
      tx.objectStore("days").put({ name, text, updated: this.now() } satisfies StoredText);
    });
    return { hash };
  }

  async readDatabase(): Promise<DatabaseFile | null> {
    const row = await request<StoredText | undefined>(
      this.db.transaction("database").objectStore("database").get(DATABASE_NAME),
    );
    if (!row) return null;
    return { text: row.text, hash: await sha256Hex(row.text) };
  }

  async writeDatabase(text: string, previous: DatabaseFile): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    const savedAt = this.now();
    await transact(this.db, ["database", "backups"], (tx) => {
      tx.objectStore("database").put({ name: DATABASE_NAME, text, updated: savedAt } satisfies StoredText);
      if (previous.text !== text) {
        tx.objectStore("backups").add({ name: DATABASE_NAME, text: previous.text, savedAt } satisfies StoredBackup);
      }
    });
    return { hash };
  }

  // A copy of the database (an import conflict), kept beside it.
  async putDatabaseCopy(name: string, text: string): Promise<void> {
    await transact(this.db, ["database"], (tx) => {
      tx.objectStore("database").put({ name, text, updated: this.now() } satisfies StoredText);
    });
  }

  async ensureDatabase(): Promise<void> {
    if (await this.readDatabase()) return;
    await this.putDatabaseCopy(DATABASE_NAME, DEFAULT_DATABASE);
  }

  // Everything, for an export: the day files (sorted) and the database.
  async exportRows(): Promise<{ days: StoredText[]; projects: StoredText | null }> {
    const days = await request<StoredText[]>(this.db.transaction("days").objectStore("days").getAll());
    const projects =
      (await request<StoredText | undefined>(this.db.transaction("database").objectStore("database").get(DATABASE_NAME))) ??
      null;
    return { days: days.sort(byName), projects };
  }

  async backups(): Promise<StoredBackup[]> {
    const rows = await request<StoredBackup[]>(this.db.transaction("backups").objectStore("backups").getAll());
    return rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0)).slice(0, 200);
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = await request<{ key: string; value: string } | undefined>(
      this.db.transaction("settings").objectStore("settings").get(key),
    );
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await transact(this.db, ["settings"], (tx) => {
      tx.objectStore("settings").put({ key, value });
    });
  }

  async deleteSetting(key: string): Promise<void> {
    await transact(this.db, ["settings"], (tx) => {
      tx.objectStore("settings").delete(key);
    });
  }

  async syncedStates(): Promise<Map<string, SyncedState>> {
    const rows = await request<({ name: string } & SyncedState)[]>(
      this.db.transaction("sync").objectStore("sync").getAll(),
    );
    return new Map(rows.map((row) => [row.name, { hash: row.hash, sha: row.sha }]));
  }

  async setSyncedState(name: string, state: SyncedState): Promise<void> {
    await transact(this.db, ["sync"], (tx) => {
      tx.objectStore("sync").put({ name, ...state });
    });
  }
}

// The sync's view of the day files: writes keep the previous version as a backup.
export function syncLocal(store: IdbStore): SyncLocal {
  return {
    list: () => store.listDays(),
    async read(name) {
      const file = await store.readDay(name);
      if (!file) throw new Error(`${name}: not found on this device`);
      return { text: file.text };
    },
    async write(name, text) {
      const previous = await store.readDay(name);
      if (!previous) throw new Error(`${name}: not found on this device`);
      await store.writeDay(name, text, previous);
    },
    async create(name, text) {
      await store.createDay(name, text);
    },
    synced: () => store.syncedStates(),
    setSynced: (name, state) => store.setSyncedState(name, state),
  };
}

// The page's data: the editor operations over the browser's storage.
export async function openLocal(): Promise<{ api: DayService; store: IdbStore }> {
  const store = new IdbStore(await openDatabase());
  await store.ensureDatabase();
  return { api: new DayService(store), store };
}
