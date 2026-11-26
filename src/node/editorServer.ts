// The editor's workspace on disk, and the HTTP routes that the browser page calls.
//
// The routes are thin: each one calls a method of DayService (src/core/workspace.ts), which is the
// same code the browser runs over IndexedDB. DiskStorage is the part that reads and writes files.
import { createHash, randomBytes } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { headerDate } from "../core/dayFiles";
import { databaseChanged, DatabaseFile, DayFile, DayFileInfo, DayService, Storage, StoreError } from "../core/workspace";
export type { ParseResult } from "../core/workspace";

export const MAX_BODY = 5 * 1024 * 1024;

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + randomBytes(3).toString("hex");

// The folder of day files and the project database file, with the backup folder for old versions.
export class DiskStorage implements Storage {
  readonly databaseLabel: string;

  constructor(
    readonly folder: string,
    readonly db: string | undefined,
    readonly backups: string,
  ) {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder}: not a folder`);
    this.databaseLabel = db ?? "projects.yml";
  }

  private dayFiles(): string[] {
    return readdirSync(this.folder)
      .filter((name) => name.endsWith(".md") && isFile(join(this.folder, name)))
      .sort();
  }

  async listDays(): Promise<DayFileInfo[]> {
    return this.dayFiles().map((name) => {
      const data = readFileSync(join(this.folder, name));
      return { name, hash: digest(data), date: headerDate(data.toString("utf-8"), new Date().getFullYear()) };
    });
  }

  async readDay(name: string): Promise<DayFile | null> {
    const path = join(this.folder, basename(name));
    if (!isFile(path)) return null;
    const data = readFileSync(path);
    const text = data.toString("utf-8");
    return { name, text, hash: digest(data), date: headerDate(text, new Date().getFullYear()) };
  }

  async writeDay(name: string, text: string, previous: DayFile): Promise<{ hash: string }> {
    const path = join(this.folder, basename(name));
    const next = Buffer.from(text, "utf-8");
    if (previous.text !== text) this.keepBackup(name, Buffer.from(previous.text, "utf-8"));
    const temporary = join(this.folder, `.${name}.tmp`);
    writeFileSync(temporary, next);
    renameSync(temporary, path);
    return { hash: digest(next) };
  }

  async createDay(name: string, text: string): Promise<{ hash: string }> {
    const next = Buffer.from(text, "utf-8");
    const temporary = join(this.folder, `.${name}.tmp`);
    writeFileSync(temporary, next);
    renameSync(temporary, join(this.folder, basename(name)));
    return { hash: digest(next) };
  }

  private keepBackup(name: string, data: Buffer): void {
    mkdirSync(this.backups, { recursive: true });
    const backup = `${basename(name, extname(name))}-${stamp()}.md`;
    writeFileSync(join(this.backups, backup), data);
  }

  async readDatabase(): Promise<DatabaseFile | null> {
    if (this.db === undefined || !isFile(this.db)) return null;
    const data = readFileSync(this.db);
    return { text: data.toString("utf-8"), hash: digest(data) };
  }

  // No await between the read and the write, so nothing else in this process can change the file
  // in between.
  async writeDatabase(text: string, previous: DatabaseFile): Promise<{ hash: string }> {
    if (this.db === undefined || !isFile(this.db)) throw new StoreError(404, "no project database");
    if (readFileSync(this.db, "utf-8") !== previous.text) throw databaseChanged(this.databaseLabel);
    const next = Buffer.from(text, "utf-8");
    if (previous.text !== text) {
      mkdirSync(this.backups, { recursive: true });
      writeFileSync(join(this.backups, `projects-${stamp()}.yml`), Buffer.from(previous.text, "utf-8"));
    }
    const temporary = join(dirname(this.db), `.${basename(this.db)}.tmp`);
    writeFileSync(temporary, next);
    renameSync(temporary, this.db);
    return { hash: digest(next) };
  }
}

// What the editor may touch: the .md files of one folder, and the project database.
export class Workspace extends DayService {
  constructor(folder: string, db: string | undefined, backups: string) {
    super(new DiskStorage(folder, db, backups));
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new StoreError(413, "request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  try {
    const parsed: unknown = JSON.parse(raw.length ? raw.toString("utf-8") : "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new StoreError(400, "request body must be a JSON object");
  }
}

function send(response: ServerResponse, status: number, body: Buffer | string, contentType: string): void {
  response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  send(response, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function staticFile(response: ServerResponse, path: string): void {
  if (!isFile(path)) throw new StoreError(404, "not found");
  const type = CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
  send(response, 200, readFileSync(path), type);
}

// viewer: the folder holding app.html and dist/ (the built page and bundle).
export function createEditorServer(workspace: DayService, viewer: string): Server {
  const page = join(viewer, "app.html");
  const bundle = join(viewer, "dist", "app.js");
  const styles = join(viewer, "dist", "app.css");

  const dispatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const name = url.searchParams.get("name") ?? "";

    if (method === "GET" && path === "/") return staticFile(response, page);
    if (method === "GET" && path === "/dist/app.js") return staticFile(response, bundle);
    if (method === "GET" && path === "/dist/app.css") return staticFile(response, styles);
    if (method === "GET" && path === "/api/days") return sendJson(response, 200, await workspace.days());
    if (method === "GET" && path === "/api/files") return sendJson(response, 200, { files: await workspace.files() });
    if (method === "GET" && path === "/api/file") return sendJson(response, 200, await workspace.read(name));
    if (method === "PUT" && path === "/api/file") {
      const body = await jsonBody(request);
      if (typeof body.text !== "string") throw new StoreError(400, 'body must be {"text": "...", "base": "..."}');
      const base = typeof body.base === "string" ? body.base : null;
      return sendJson(response, 200, await workspace.write(name, body.text, base));
    }
    if (method === "POST" && path === "/api/file") {
      const body = await jsonBody(request);
      if (typeof body.name !== "string" || typeof body.text !== "string") {
        throw new StoreError(400, 'body must be {"name": "...", "text": "..."}');
      }
      return sendJson(response, 200, await workspace.create(body.name, body.text));
    }
    if (method === "POST" && path === "/api/parse") {
      const body = await jsonBody(request);
      if (typeof body.text !== "string") throw new StoreError(400, 'body must be {"text": "..."}');
      return sendJson(response, 200, await workspace.parse(body.text));
    }
    if (method === "GET" && path === "/api/projects") return sendJson(response, 200, await workspace.projects());
    if (method === "PUT" && path === "/api/projects") {
      const body = await jsonBody(request);
      if (typeof body.text !== "string") throw new StoreError(400, 'body must be {"text": "...", "base": "..."}');
      const base = typeof body.base === "string" ? body.base : null;
      return sendJson(response, 200, await workspace.saveProjects(body.text, base));
    }
    if (method === "POST" && path === "/api/projects") {
      const body = await jsonBody(request);
      if (typeof body.name !== "string") throw new StoreError(400, 'body must be {"name": "..."}');
      return sendJson(response, 200, await workspace.createProject(body.name));
    }
    if (method === "GET" && path === "/api/vocabulary") {
      return sendJson(response, 200, { descriptions: await workspace.vocabulary() });
    }
    throw new StoreError(404, `no such page: ${path}`);
  };

  return createServer((request, response) => {
    dispatch(request, response).catch((err: unknown) => {
      if (err instanceof StoreError) return sendJson(response, err.status, { error: err.message });
      sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}
