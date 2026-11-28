// Deleting a day file: the core DayService check (the base hash, as a write has), and the disk
// storage, which removes the .md file and its .json and keeps both as backups. Temp folders only.
import test, { describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskStorage } from "../src/node/editorServer";
import { DayFile, DayFileInfo, DayService, DatabaseFile, Storage, StoreError } from "../src/core/workspace";

const digest = (text: string) => createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");

const DAY = "#toggl 12/11\n- [ ] 0800 X\n- [ ] 0900 gym\n";
const JSON_TEXT = '{"date":"2026-11-12","entries":[]}\n';

// A Storage that only keeps day texts in memory: DayService does the checks, and this records the deletes.
class MemoryDays implements Storage {
  readonly databaseLabel = "projects.yml";
  readonly days = new Map<string, string>();
  readonly deleted: string[] = [];

  async listDays(): Promise<DayFileInfo[]> {
    return [...this.days].map(([name, text]) => ({ name, hash: digest(text), date: null }));
  }
  async readDay(name: string): Promise<DayFile | null> {
    const text = this.days.get(name);
    return text === undefined ? null : { name, text, hash: digest(text), date: null };
  }
  async writeDay(): Promise<{ hash: string }> {
    throw new Error("not used by these tests");
  }
  async createDay(): Promise<{ hash: string }> {
    throw new Error("not used by these tests");
  }
  async deleteDay(name: string): Promise<void> {
    this.days.delete(name);
    this.deleted.push(name);
  }
  async readDatabase(): Promise<DatabaseFile | null> {
    return null;
  }
  async writeDatabase(): Promise<{ hash: string }> {
    throw new Error("not used by these tests");
  }
}

describe("DayService.delete (the check every storage gets)", () => {
  test("a day is deleted when the base is the hash it has now", async () => {
    const storage = new MemoryDays();
    storage.days.set("12-11.md", DAY);
    await new DayService(storage).delete("12-11.md", digest(DAY));
    assert.deepEqual(storage.deleted, ["12-11.md"]);
    assert.equal(storage.days.has("12-11.md"), false);
  });

  test("a delete is refused when the file changed since it was opened, and the storage is not asked", async () => {
    const storage = new MemoryDays();
    storage.days.set("12-11.md", "someone else's edit\n");
    await assert.rejects(new DayService(storage).delete("12-11.md", digest(DAY)), (err: unknown) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.status, 409);
      assert.match(err.message, /changed on disk/);
      return true;
    });
    assert.deepEqual(storage.deleted, []);
    assert.equal(storage.days.get("12-11.md"), "someone else's edit\n");
  });

  test("a delete of a file that is not there is 404", async () => {
    await assert.rejects(new DayService(new MemoryDays()).delete("12-11.md", digest(DAY)), (err: unknown) => err instanceof StoreError && err.status === 404);
  });

  test("only .md files in the folder can be deleted", async () => {
    await assert.rejects(new DayService(new MemoryDays()).delete("../projects.yml", null), (err: unknown) => err instanceof StoreError && err.status === 400);
  });
});

describe("disk storage delete", () => {
  let root: string;
  let folder: string;
  let backups: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "tp-delete-disk-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(join(root, "case"), { recursive: true, force: true });
    folder = join(root, "case", "data");
    backups = join(root, "case", "build", "editor-backups");
    mkdirSync(folder, { recursive: true });
  });

  const service = () => new DayService(new DiskStorage(folder, undefined, backups));
  const backupsOf = (ext: string) => readdirSync(backups).filter((name) => name.startsWith("12-11-") && name.endsWith(ext));

  test("the day file and its JSON are removed, and both are kept as backups", async () => {
    writeFileSync(join(folder, "12-11.md"), DAY);
    writeFileSync(join(folder, "12-11.json"), JSON_TEXT);

    await service().delete("12-11.md", digest(DAY));

    assert.equal(existsSync(join(folder, "12-11.md")), false);
    assert.equal(existsSync(join(folder, "12-11.json")), false);
    assert.deepEqual(backupsOf(".md").map((name) => readFileSync(join(backups, name), "utf-8")), [DAY]);
    assert.deepEqual(backupsOf(".json").map((name) => readFileSync(join(backups, name), "utf-8")), [JSON_TEXT]);
    assert.deepEqual(await service().files(), []);
  });

  test("a day with no JSON is removed alone, and only its text is kept", async () => {
    writeFileSync(join(folder, "12-11.md"), DAY);

    await service().delete("12-11.md", digest(DAY));

    assert.equal(existsSync(join(folder, "12-11.md")), false);
    assert.deepEqual(backupsOf(".md").length, 1);
    assert.deepEqual(backupsOf(".json"), []);
  });

  test("a delete is refused when the file changed on disk, and neither file is touched", async () => {
    writeFileSync(join(folder, "12-11.md"), "someone else's edit\n");
    writeFileSync(join(folder, "12-11.json"), JSON_TEXT);

    await assert.rejects(service().delete("12-11.md", digest(DAY)), (err: unknown) => err instanceof StoreError && err.status === 409);

    assert.equal(readFileSync(join(folder, "12-11.md"), "utf-8"), "someone else's edit\n");
    assert.equal(readFileSync(join(folder, "12-11.json"), "utf-8"), JSON_TEXT);
    assert.equal(existsSync(backups), false);
  });
});
