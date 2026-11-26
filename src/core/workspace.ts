// The day files and the project database as the editor sees them, whatever keeps them: a folder
// on disk (the Node server) or the browser's IndexedDB. A Storage only reads and writes; DayService
// does the checks that must match everywhere: the file names, the base-hash conflict check, the
// project database checks, and the parse.
import { TimeParseError } from "./errors";
import { ParsedDay, parseDay } from "./parser";
import { keywordsOf, loadDatabase } from "./reports";
import { addProjectText } from "./projectsText";

export type ParseResult = { ok: true; day: ParsedDay } | { ok: false; error: string };

export interface DayFileInfo {
  name: string;
  hash: string;
  date: string | null; // YYYY-MM-DD from the header, or null when the header is not a valid date (see dayFiles.ts)
}

export interface DayFile extends DayFileInfo {
  text: string;
}

export interface DatabaseFile {
  text: string;
  hash: string;
}

// An error with the HTTP status the editor answers with (400 bad request, 404 missing, 409 conflict).
export class StoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

// The conflict a write gets when the stored text is no longer the version the caller read.
export function databaseChanged(label: string): StoreError {
  return new StoreError(409, `${label} changed on disk since it was loaded; reload it before saving`);
}

// The storage contract. Hashes are SHA-256 of the UTF-8 bytes, in hex. Writes keep the previous
// version (the storage decides where): writeDay and writeDatabase get the version they replace.
// Both writes save only while the stored text still equals previous.text, checked in the same step
// as the write (one transaction in the browser); otherwise they throw StoreError 409.
export interface Storage {
  // How the database is named in messages, such as "projects.yml" or a path.
  readonly databaseLabel: string;
  listDays(): Promise<DayFileInfo[]>;
  // null when there is no such day file.
  readDay(name: string): Promise<DayFile | null>;
  writeDay(name: string, text: string, previous: DayFile): Promise<{ hash: string }>;
  createDay(name: string, text: string): Promise<{ hash: string }>;
  // null when there is no database.
  readDatabase(): Promise<DatabaseFile | null>;
  writeDatabase(text: string, previous: DatabaseFile): Promise<{ hash: string }>;
}

// The file names the editor accepts: a Markdown file, with no folder part.
export function checkDayName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || !name.endsWith(".md")) {
    throw new StoreError(400, "only .md files in the editor folder can be opened");
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The operations the editor page uses. The Node server serves them over HTTP, and the browser runs
// DayService directly. Failures are StoreError, with the status the HTTP route would answer with.
export interface EditorApi {
  files(): Promise<DayFileInfo[]>;
  read(name: string): Promise<DayFile>;
  write(name: string, text: string, base: string | null): Promise<{ name: string; hash: string; parse: ParseResult }>;
  create(name: string, text: string): Promise<{ name: string; hash: string; parse: ParseResult }>;
  parse(text: string): Promise<ParseResult>;
  projects(): Promise<DatabaseFile>;
  saveProjects(text: string, base: string | null): Promise<{ hash: string }>;
  createProject(name: string): Promise<{ name: string; keywords: string[] }>;
  vocabulary(): Promise<string[]>;
  days(): Promise<{ files: { name: string; text: string }[]; errors: { name: string; message: string }[] }>;
}

export class DayService implements EditorApi {
  constructor(readonly storage: Storage) {}

  files(): Promise<DayFileInfo[]> {
    return this.storage.listDays();
  }

  async read(name: string): Promise<DayFile> {
    checkDayName(name);
    const file = await this.storage.readDay(name);
    if (!file) throw new StoreError(404, `${name}: not found in the editor folder`);
    return file;
  }

  // Saves the text if the file still has the version the editor read (base is its hash).
  async write(name: string, text: string, base: string | null): Promise<{ name: string; hash: string; parse: ParseResult }> {
    const current = await this.read(name);
    if (base !== current.hash) {
      throw new StoreError(409, `${name} changed on disk since it was opened; reload it before saving`);
    }
    const saved = await this.storage.writeDay(name, text, current);
    return { name, hash: saved.hash, parse: await this.parse(text) };
  }

  // A new day file. It must not exist yet.
  async create(name: string, text: string): Promise<{ name: string; hash: string; parse: ParseResult }> {
    checkDayName(name);
    if (await this.storage.readDay(name)) throw new StoreError(409, `${name} already exists`);
    const saved = await this.storage.createDay(name, text);
    return { name, hash: saved.hash, parse: await this.parse(text) };
  }

  private async keywords(): Promise<Record<string, string[]>> {
    const database = await this.storage.readDatabase();
    if (!database) return {};
    return Object.fromEntries(keywordsOf(loadDatabase(database.text, this.storage.databaseLabel)));
  }

  async parse(text: string): Promise<ParseResult> {
    let projects: Record<string, string[]>;
    try {
      projects = await this.keywords();
    } catch (err) {
      return { ok: false, error: `project database: ${messageOf(err)}` };
    }
    try {
      return { ok: true, day: parseDay(text, { projects }) };
    } catch (err) {
      if (err instanceof TimeParseError) return { ok: false, error: err.message };
      throw err;
    }
  }

  // The database text and its hash. A missing database is a 404.
  async projects(): Promise<DatabaseFile> {
    const database = await this.storage.readDatabase();
    if (!database) throw new StoreError(404, "no project database");
    return database;
  }

  // Saves the whole database text. It must parse as a database, and the file must still be the
  // version the caller read (base is its hash). The storage checks the stored text again in the
  // same step as the write, so a save made by another tab in between is refused too.
  async saveProjects(text: string, base: string | null): Promise<{ hash: string }> {
    const current = await this.projects();
    if (base !== current.hash) throw databaseChanged(this.storage.databaseLabel);
    try {
      loadDatabase(text, this.storage.databaseLabel);
    } catch (err) {
      throw new StoreError(400, messageOf(err));
    }
    return this.storage.writeDatabase(text, current);
  }

  // A new project is added to the text read here, and written only if that text is still stored.
  async createProject(name: string): Promise<{ name: string; keywords: string[] }> {
    const current = await this.projects();
    let added;
    try {
      added = addProjectText(current.text, name, undefined, this.storage.databaseLabel);
    } catch (err) {
      throw new StoreError(400, messageOf(err));
    }
    await this.storage.writeDatabase(added.text, current);
    return { name: added.project.name, keywords: added.project.keywords };
  }

  // Every day file as parser output (name and JSON text), and the files that failed.
  async days(): Promise<{ files: { name: string; text: string }[]; errors: { name: string; message: string }[] }> {
    let projects: Record<string, string[]>;
    try {
      projects = await this.keywords();
    } catch (err) {
      return { files: [], errors: [{ name: "projects.yml", message: messageOf(err) }] };
    }
    const files: { name: string; text: string }[] = [];
    const errors: { name: string; message: string }[] = [];
    for (const { name } of await this.storage.listDays()) {
      const file = await this.storage.readDay(name);
      if (!file) continue;
      try {
        files.push({ name, text: JSON.stringify(parseDay(file.text, { projects })) });
      } catch (err) {
        errors.push({ name, message: messageOf(err) });
      }
    }
    return { files, errors };
  }

  // Descriptions used in the folder, most used first.
  async vocabulary(): Promise<string[]> {
    const counts = new Map<string, number>();
    for (const { name } of await this.storage.listDays()) {
      const file = await this.storage.readDay(name);
      if (!file) continue;
      let day: ParsedDay;
      try {
        day = parseDay(file.text);
      } catch {
        continue;
      }
      for (const entry of day.entries) {
        const text = entry.description.trim();
        if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }
    return [...counts.keys()]
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .slice(0, 500);
  }
}
