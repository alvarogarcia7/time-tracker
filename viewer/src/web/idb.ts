// The browser's storage: the day files, the project database, their old versions, the sync state
// and the settings, in one IndexedDB database on this device. It implements the same Storage
// contract as the Node disk storage, so DayService behaves the same in both.
import { headerDate } from "@core/dayFiles";
import { sha256Hex } from "@core/hash";
import type { SyncedState, SyncLocal } from "@core/sync";
import { databaseChanged, DatabaseFile, DayFile, DayFileInfo, DayService, Storage, StoreError } from "@core/workspace";

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
      rows
        .sort(byName)
        .map(async (row) => ({ name: row.name, hash: await sha256Hex(row.text), date: headerDate(row.text, new Date().getFullYear()) })),
    );
  }

  async readDay(name: string): Promise<DayFile | null> {
    const row = await request<StoredText | undefined>(this.db.transaction("days").objectStore("days").get(name));
    if (!row) return null;
    return { name, text: row.text, hash: await sha256Hex(row.text), date: headerDate(row.text, new Date().getFullYear()) };
  }

  // Replaces a row of the days or database store only while its stored text is still expectedText. The
  // check and the write are one transaction, so a save made in another tab or during a sync cannot slip
  // in between.
  private replaceRowIfText(
    store: "days" | "database",
    name: string,
    text: string,
    expectedText: string,
  ): Promise<"ok" | "missing" | "changed"> {
    const savedAt = this.now();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([store, "backups"], "readwrite");
      let outcome: "ok" | "missing" | "changed" = "ok";
      tx.oncomplete = () => resolve(outcome);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("the change was not saved"));
      const read = tx.objectStore(store).get(name);
      read.onerror = () => reject(read.error);
      read.onsuccess = () => {
        const row = read.result as StoredText | undefined;
        if (!row) {
          outcome = "missing";
          return;
        }
        if (row.text !== expectedText) {
          outcome = "changed";
          return;
        }
        tx.objectStore(store).put({ name, text, updated: savedAt } satisfies StoredText);
        if (expectedText !== text) {
          tx.objectStore("backups").add({ name, text: expectedText, savedAt } satisfies StoredBackup);
        }
      };
    });
  }

  async writeDay(name: string, text: string, previous: DayFile): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    const outcome = await this.replaceRowIfText("days", name, text, previous.text);
    if (outcome === "missing") throw new StoreError(404, `${name}: not found in the editor folder`);
    if (outcome === "changed") {
      throw new StoreError(409, `${name} changed on disk since it was opened; reload it before saving`);
    }
    return { hash };
  }

  // Replaces a day file with text when it still reads as expectedText (used by the sync).
  async replaceDayUnlessChanged(name: string, text: string, expectedText: string): Promise<boolean> {
    return (await this.replaceRowIfText("days", name, text, expectedText)) === "ok";
  }

  // Removes a day file (only used for a conflict copy this sync created, before it was sent).
  async deleteDay(name: string): Promise<void> {
    await transact(this.db, ["days"], (tx) => {
      tx.objectStore("days").delete(name);
    });
  }

  // A new day file. An existing file of the same name is never replaced (the store refuses it).
  async createDay(name: string, text: string): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction(["days"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error(`${name} was not created`));
      const add = tx.objectStore("days").add({ name, text, updated: this.now() } satisfies StoredText);
      add.onerror = () => reject(new StoreError(409, `${name} already exists`));
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

  // Saves the database only while its stored text is still previous.text (one transaction, as for days).
  async writeDatabase(text: string, previous: DatabaseFile): Promise<{ hash: string }> {
    const hash = await sha256Hex(text);
    const outcome = await this.replaceRowIfText("database", DATABASE_NAME, text, previous.text);
    if (outcome === "missing") throw new StoreError(404, "no project database");
    if (outcome === "changed") throw databaseChanged(this.databaseLabel);
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

  // Everything, for an export: the day files (sorted), the database, and its conflict copies.
  async exportRows(): Promise<{ days: StoredText[]; projects: StoredText | null; copies: StoredText[] }> {
    const days = await request<StoredText[]>(this.db.transaction("days").objectStore("days").getAll());
    const databases = await request<StoredText[]>(this.db.transaction("database").objectStore("database").getAll());
    const projects = databases.find((row) => row.name === DATABASE_NAME) ?? null;
    const copies = databases.filter((row) => row.name !== DATABASE_NAME).sort(byName);
    return { days: days.sort(byName), projects, copies };
  }

  // Removes a conflict copy of the database. The database itself is never removed.
  async deleteDatabaseCopy(name: string): Promise<void> {
    if (name === DATABASE_NAME || !name.endsWith(".yml")) throw new Error(`${name}: not a project database copy`);
    await transact(this.db, ["database"], (tx) => {
      tx.objectStore("database").delete(name);
    });
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
    write: (name, text, expectedText) => store.replaceDayUnlessChanged(name, text, expectedText),
    remove: (name) => store.deleteDay(name),
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
