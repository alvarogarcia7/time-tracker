import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:http";

import { createEditorServer, DiskStorage, Workspace } from "../src/node/editorServer";
import { DayService, StoreError } from "../src/core/workspace";

const DAY = "#toggl 11/11\n- [ ] 0800 X\n- [ ] 0900 gym\n- [ ] \n";
const PROJECTS = "gym:\n  category: personal\n  keywords: [gym]\nlost: [lost]\n";
const digest = (text: string) => createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");

describe("editor server", () => {
  let root: string;
  let folder: string;
  let db: string;
  let viewer: string;
  let backups: string;
  let server: Server;
  let base: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "tp-editor-"));
    folder = join(root, "data");
    mkdirSync(folder);
    writeFileSync(join(folder, "11-11.md"), DAY);
    writeFileSync(join(folder, "notes.txt"), "not a day");
    db = join(root, "projects.yml");
    writeFileSync(db, PROJECTS);
    viewer = join(root, "viewer");
    mkdirSync(join(viewer, "dist"), { recursive: true });
    writeFileSync(join(viewer, "app.html"), "<!doctype html><title>editor</title>");
    writeFileSync(join(viewer, "dist", "app.js"), "// bundle");
    backups = join(root, "backups");
    server = createEditorServer(new Workspace(folder, db, backups), viewer);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; text: string }> {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, data: type.startsWith("application/json") ? JSON.parse(text) : null, text };
  }

  test("the page and the bundle are served", async () => {
    const page = await call("GET", "/");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("editor"));
    assert.equal((await call("GET", "/dist/app.js")).text, "// bundle");
  });

  test("only day files are listed", async () => {
    const { data } = await call("GET", "/api/files");

    assert.deepEqual(data.files.map((f: { name: string }) => f.name), ["11-11.md"]);
    assert.equal(data.files[0].hash, digest(DAY));
    assert.match(data.files[0].date, /^\d{4}-11-11$/); // the header's day, with the current year
  });

  test("a file can be read", async () => {
    const { status, data } = await call("GET", "/api/file?name=11-11.md");

    assert.equal(status, 200);
    assert.equal(data.text, DAY);
  });

  test("a save writes the file and keeps a backup of the old text", async () => {
    const next = DAY.replace("0800 X", "0800 focus");

    const { status, data } = await call("PUT", "/api/file?name=11-11.md", { text: next, base: digest(DAY) });

    assert.equal(status, 200);
    assert.equal(readFileSync(join(folder, "11-11.md"), "utf-8"), next);
    assert.equal(data.hash, digest(next));
    assert.equal(data.parse.ok, true);
    const kept = readdirSync(backups).filter((name) => name.startsWith("11-11-"));
    assert.deepEqual(kept.map((name) => readFileSync(join(backups, name), "utf-8")), [DAY]);
  });

  test("a save is refused when the file changed on disk", async () => {
    writeFileSync(join(folder, "11-11.md"), "someone else's edit\n");

    const { status, data } = await call("PUT", "/api/file?name=11-11.md", { text: "mine\n", base: digest(DAY) });

    assert.equal(status, 409);
    assert.match(data.error, /changed on disk/);
    assert.equal(readFileSync(join(folder, "11-11.md"), "utf-8"), "someone else's edit\n");
  });

  test("text that does not parse is saved and the error is reported", async () => {
    const current = digest("someone else's edit\n");
    const bad = "#toggl 11/11\n- [ ] 2500 bad\n";

    const { status, data } = await call("PUT", "/api/file?name=11-11.md", { text: bad, base: current });

    assert.equal(status, 200);
    assert.equal(data.parse.ok, false);
    assert.match(data.parse.error, /line 2/);
  });

  test("an identical save makes no backup", async () => {
    rmSync(backups, { recursive: true, force: true });
    const current = digest("#toggl 11/11\n- [ ] 2500 bad\n");

    await call("PUT", "/api/file?name=11-11.md", { text: "#toggl 11/11\n- [ ] 2500 bad\n", base: current });

    assert.equal(existsSync(backups), false);
  });

  test("only existing .md files in the folder can be opened", async () => {
    assert.equal((await call("GET", "/api/file?name=notes.txt")).status, 400);
    assert.equal((await call("GET", "/api/file?name=..%2Fprojects.yml")).status, 400);
    assert.equal((await call("GET", "/api/file?name=missing.md")).status, 404);
    assert.equal((await call("GET", "/api/file")).status, 400);
  });

  test("nothing can be written outside the folder", async () => {
    const { status } = await call("PUT", "/api/file?name=..%2Fevil.md", { text: "x", base: null });

    assert.equal(status, 400);
    assert.equal(existsSync(join(root, "evil.md")), false);
  });

  test("a PUT needs a text field", async () => {
    assert.equal((await call("PUT", "/api/file?name=11-11.md", { base: "x" })).status, 400);
  });

  test("the parse endpoint gives entries with line numbers", async () => {
    const { data } = await call("POST", "/api/parse", { text: DAY });

    assert.equal(data.ok, true);
    assert.deepEqual(data.day.entries.map((e: { line: number; start: string }) => [e.line, e.start]), [
      [2, "08:00"],
      [3, "09:00"],
    ]);
  });

  test("the parse endpoint reports errors without failing", async () => {
    const { status, data } = await call("POST", "/api/parse", { text: "#toggl 11/11\n- [ ] 2500 x\n" });

    assert.equal(status, 200);
    assert.equal(data.ok, false);
    assert.match(data.error, /line 2/);
  });

  test("a parse error names its line and gives the entries above it", async () => {
    const { data } = await call("POST", "/api/parse", { text: "#toggl 11/11\n- [ ] 0800 X\n- [ ] 0900 gym\n- [ ] 2500 bad\n" });

    assert.equal(data.ok, false);
    assert.equal(data.line, 4);
    assert.deepEqual(data.entries.map((e: { line: number; start: string; end: string | null }) => [e.line, e.start, e.end]), [
      [2, "08:00", "09:00"],
      [3, "09:00", null],
    ]);
  });

  test("the projects endpoint returns the database text and its hash", async () => {
    const { data } = await call("GET", "/api/projects");

    assert.equal(data.text, PROJECTS);
    assert.equal(data.hash, digest(PROJECTS));
  });

  test("the database is saved when it parses and was not changed since it was read", async () => {
    const next = PROJECTS + "work:\n  category: professional\n  keywords: [client]\n";

    const { status, data } = await call("PUT", "/api/projects", { text: next, base: digest(PROJECTS) });

    assert.equal(status, 200);
    assert.equal(readFileSync(db, "utf-8"), next);
    assert.equal(data.hash, digest(next));
    writeFileSync(db, PROJECTS);
  });

  test("a database save is refused when the file changed on disk", async () => {
    const { status, data } = await call("PUT", "/api/projects", { text: PROJECTS, base: digest("old") });

    assert.equal(status, 409);
    assert.match(data.error, /changed on disk/);
  });

  test("a database that does not parse is refused and the file is left alone", async () => {
    const { status, data } = await call("PUT", "/api/projects", { text: "gym:\n  - x\nfitness:\n  - x\n", base: digest(PROJECTS) });

    assert.equal(status, 400);
    assert.match(data.error, /maps to both/);
    assert.equal(readFileSync(db, "utf-8"), PROJECTS);
  });

  test("the days of the folder are returned as parser output, with failures listed", async () => {
    writeFileSync(join(folder, "11-11.md"), DAY);
    writeFileSync(join(folder, "11-13.md"), "#toggl 13/11\n- [ ] 2500 bad\n");

    const { data } = await call("GET", "/api/days");

    const names = data.files.map((f: { name: string }) => f.name);
    assert.ok(names.includes("11-11.md"));
    assert.ok(!names.includes("11-13.md"));
    assert.deepEqual(data.errors.map((e: { name: string }) => e.name), ["11-13.md"]);
    const day = JSON.parse(data.files.find((f: { name: string }) => f.name === "11-11.md").text);
    assert.equal(day.date, "2026-11-11");
    rmSync(join(folder, "11-13.md"));
  });

  test("a project is created in the database", async () => {
    const { status, data } = await call("POST", "/api/projects", { name: "lunch" });

    assert.equal(status, 200);
    assert.deepEqual(data, { name: "lunch", keywords: ["lunch"] });
    assert.match(readFileSync(db, "utf-8"), /lunch:/);
  });

  test("a refused project gives a message and leaves the file alone", async () => {
    const before = readFileSync(db, "utf-8");

    const { status, data } = await call("POST", "/api/projects", { name: "gym" });

    assert.equal(status, 400);
    assert.match(data.error, /gym/);
    assert.equal(readFileSync(db, "utf-8"), before);
  });

  test("a project needs a name", async () => {
    assert.equal((await call("POST", "/api/projects", {})).status, 400);
  });

  test("the vocabulary lists the descriptions most used first", async () => {
    writeFileSync(join(folder, "11-12.md"), "#toggl 12/11\n- [ ] 0800 gym\n- [ ] 0900 gym\n- [ ] 1000 X\n- [ ] \n");

    const { data } = await call("GET", "/api/vocabulary");

    assert.equal(data.descriptions[0], "gym");
    assert.ok(data.descriptions.includes("X"));
  });

  test("an unknown page is 404", async () => {
    assert.equal((await call("GET", "/nope")).status, 404);
  });

  test("the projects endpoint without a database is 404, and so is creating a project", async () => {
    const plain = createEditorServer(new Workspace(folder, undefined, backups), viewer);
    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", () => resolve()));
    const address = plain.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 404);
      const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "lunch" }),
      });
      assert.equal(created.status, 404);
    } finally {
      plain.close();
    }
  });
});

// A second tab saves the database between this tab's read and its write, which is the window a
// stale save used to slip through.
class OtherTabSaves extends DiskStorage {
  armed = false;

  constructor(
    folder: string,
    private readonly file: string,
    private readonly newer: string,
    backups: string,
  ) {
    super(folder, file, backups);
  }

  override async readDatabase() {
    const database = await super.readDatabase();
    if (this.armed) {
      this.armed = false;
      writeFileSync(this.file, this.newer);
    }
    return database;
  }
}

describe("a database save made from a stale copy", () => {
  const OLD = "gym:\n  category: personal\n  keywords: [gym]\n";
  const NEWER = OLD + "work:\n  category: professional\n  keywords: [client]\n";

  function setup(): { root: string; db: string; storage: OtherTabSaves } {
    const root = mkdtempSync(join(tmpdir(), "tp-stale-db-"));
    const db = join(root, "projects.yml");
    writeFileSync(db, OLD);
    const storage = new OtherTabSaves(root, db, NEWER, join(root, "backups"));
    return { root, db, storage };
  }

  test("a save is refused when another tab saves in between, and the newer text is kept", async () => {
    const { root, db, storage } = setup();
    try {
      storage.armed = true;
      await assert.rejects(
        new DayService(storage).saveProjects(OLD + "fitness:\n  keywords: [run]\n", digest(OLD)),
        (err: unknown) => err instanceof StoreError && err.status === 409,
      );
      assert.equal(readFileSync(db, "utf-8"), NEWER);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a new project is refused when another tab saves in between, and the newer text is kept", async () => {
    const { root, db, storage } = setup();
    try {
      storage.armed = true;
      await assert.rejects(
        new DayService(storage).createProject("lunch"),
        (err: unknown) => err instanceof StoreError && err.status === 409,
      );
      assert.equal(readFileSync(db, "utf-8"), NEWER);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
