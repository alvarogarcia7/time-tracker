// The sync against a fake GitHub (an in-memory fetch): no network, nothing written anywhere.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { githubRepo, GitHubError, decodeBase64, encodeBase64 } from "../src/core/github";
import { conflictName, syncDays, SyncedState, SyncLocal } from "../src/core/sync";
import { sha256Hex } from "../src/core/hash";

const OWNER = "alice";
const REPO = "time-tracker-data";
const TOKEN = "github_pat_test";
const NOW = new Date(2026, 10, 25, 10, 15, 0);

// A GitHub repository with the contents API, for the one repository the tests use.
class FakeGitHub {
  readonly files = new Map<string, { text: string; sha: string }>();
  repoExists = true;
  rejectPutFor = new Set<string>();
  requests: string[] = [];

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    this.requests.push(`${method} ${path}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });
    const repo = `/repos/${OWNER}/${REPO}`;
    if (path === repo) return this.repoExists ? json(200, { name: REPO }) : json(404, { message: "Not Found" });
    if (path === `${repo}/contents/`) {
      if (this.files.size === 0) return json(404, { message: "This repository is empty." });
      return json(
        200,
        [...this.files].map(([name, file]) => ({ type: "file", name, path: name, sha: file.sha })),
      );
    }
    const blob = path.match(new RegExp(`^${repo}/git/blobs/(.+)$`));
    if (blob && method === "GET") {
      const found = [...this.files.values()].find((file) => file.sha === blob[1]);
      if (!found) return json(404, { message: "Not Found" });
      return json(200, { sha: found.sha, size: new TextEncoder().encode(found.text).length, encoding: "base64", content: encodeBase64(found.text) });
    }
    const match = path.match(new RegExp(`^${repo}/contents/(.+)$`));
    if (!match) return json(404, { message: "Not Found" });
    const name = decodeURIComponent(match[1]);
    const existing = this.files.get(name);

    if (method === "GET") {
      if (!existing) return json(404, { message: "Not Found" });
      const size = new TextEncoder().encode(existing.text).length;
      return json(200, { type: "file", name, path: name, sha: existing.sha, size, encoding: "base64", content: encodeBase64(existing.text) });
    }
    if (method === "PUT") {
      if (this.rejectPutFor.has(name)) return json(500, { message: "Server Error" });
      const body = JSON.parse(String(init?.body));
      if (existing && body.sha === undefined) return json(422, { message: "sha wasn't supplied" });
      if (!existing && body.sha !== undefined) return json(422, { message: "sha was supplied for a new file" });
      if (existing && existing.sha !== body.sha) return json(409, { message: "conflict" });
      const text = decodeBase64(body.content);
      const sha = await sha256Hex(text);
      this.files.set(name, { text, sha });
      return json(existing ? 200 : 201, { content: { name, path: name, sha }, commit: {} });
    }
    return json(405, { message: "Method Not Allowed" });
  };

  // The remote as the sync sees it, with the same client the page uses.
  remote(token = TOKEN) {
    return githubRepo({ owner: OWNER, repo: REPO, token, fetch: this.fetch });
  }
}

// A device's day files, kept in memory.
class MemoryLocal implements SyncLocal {
  readonly days = new Map<string, string>();
  readonly backups: string[] = [];
  private readonly state = new Map<string, SyncedState>();

  async list() {
    return Promise.all([...this.days].map(async ([name, text]) => ({ name, hash: await sha256Hex(text) })));
  }
  async read(name: string) {
    const text = this.days.get(name);
    if (text === undefined) throw new Error(`${name}: missing`);
    return { text };
  }
  async write(name: string, text: string, expectedText: string) {
    if (this.days.get(name) !== expectedText) return false;
    this.backups.push(expectedText);
    this.days.set(name, text);
    return true;
  }
  async create(name: string, text: string) {
    if (this.days.has(name)) throw new Error(`${name}: exists`);
    this.days.set(name, text);
  }
  async synced() {
    return new Map(this.state);
  }
  async setSynced(name: string, state: SyncedState) {
    this.state.set(name, state);
  }
}

const DAY = "25/11/2026\n- [ ] 0900 standup, client-a\n- [ ] 1000 focus\n";

describe("GitHub contents API client", () => {
  test("text survives the base64 round trip, including non-ASCII", () => {
    const text = "25/11/2026\n- [ ] 0900 café, naïve ✓\n";
    assert.equal(decodeBase64(encodeBase64(text)), text);
  });

  test("a repository with no files lists as empty, and the first PUT creates a file", async () => {
    const gh = new FakeGitHub();
    const remote = gh.remote();
    assert.deepEqual(await remote.list(), []);
    const created = await remote.put("2026-11-25.md", DAY, null, "first");
    assert.equal(gh.files.get("2026-11-25.md")?.text, DAY);
    assert.equal(created.sha, gh.files.get("2026-11-25.md")?.sha);
  });

  test("only root Markdown files are listed", async () => {
    const gh = new FakeGitHub();
    await gh.remote().put("a.md", "x", null, "m");
    gh.files.set("notes.txt", { text: "x", sha: "s" });
    assert.deepEqual(
      (await gh.remote().list()).map((file) => file.name),
      ["a.md"],
    );
  });

  test("a rejected token and a missing repository explain what to check", async () => {
    const gh = new FakeGitHub();
    await assert.rejects(gh.remote("wrong").list(), (err: unknown) => err instanceof GitHubError && /token/.test(String(err.message)));
    gh.repoExists = false;
    await assert.rejects(gh.remote().list(), (err: unknown) => err instanceof GitHubError && err.status === 404);
  });
});

describe("sync of the day files", () => {
  test("a day made on the phone reaches an empty repository", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    phone.days.set("2026-11-25.md", DAY);
    const outcome = await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    assert.deepEqual(outcome.pushed, ["2026-11-25.md"]);
    assert.equal(gh.files.get("2026-11-25.md")?.text, DAY);
    assert.deepEqual(outcome.errors, []);
  });

  test("a second device pulls the day, and a later change flows both ways", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    const laptop = new MemoryLocal();
    phone.days.set("2026-11-25.md", DAY);
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    const pulled = await syncDays(laptop, gh.remote(), { device: "Laptop", now: NOW });
    assert.deepEqual(pulled.pulled, ["2026-11-25.md"]);
    assert.equal(laptop.days.get("2026-11-25.md"), DAY);

    laptop.days.set("2026-11-25.md", DAY + "- [ ] 1100 lunch\n");
    assert.deepEqual((await syncDays(laptop, gh.remote(), { device: "Laptop", now: NOW })).pushed, ["2026-11-25.md"]);
    assert.deepEqual((await syncDays(phone, gh.remote(), { device: "Phone", now: NOW })).pulled, ["2026-11-25.md"]);
    assert.equal(phone.days.get("2026-11-25.md"), DAY + "- [ ] 1100 lunch\n");
    assert.deepEqual(phone.backups, [DAY]); // the previous version is kept
  });

  test("an unchanged second sync does nothing", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    phone.days.set("2026-11-25.md", DAY);
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    const again = await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    assert.deepEqual([again.pushed, again.pulled, again.conflicts], [[], [], []]);
  });

  test("when both sides changed, the remote version stays and this device's version is kept as a copy", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    const laptop = new MemoryLocal();
    phone.days.set("2026-11-25.md", DAY);
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    await syncDays(laptop, gh.remote(), { device: "Laptop", now: NOW });

    laptop.days.set("2026-11-25.md", DAY + "- [ ] 1200 laptop edit\n");
    phone.days.set("2026-11-25.md", DAY + "- [ ] 1300 phone edit\n");
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });

    const outcome = await syncDays(laptop, gh.remote(), { device: "Laptop", now: NOW });
    assert.equal(outcome.conflicts.length, 1);
    const copy = outcome.conflicts[0].copy;
    assert.equal(copy, "2026-11-25.conflict-laptop-20261125-101500.md");
    assert.equal(laptop.days.get("2026-11-25.md"), DAY + "- [ ] 1300 phone edit\n");
    assert.equal(laptop.days.get(copy), DAY + "- [ ] 1200 laptop edit\n");
    assert.equal(gh.files.get(copy)?.text, DAY + "- [ ] 1200 laptop edit\n");
    assert.equal(gh.files.get("2026-11-25.md")?.text, DAY + "- [ ] 1300 phone edit\n");

    // The phone gets the copy on its next sync, and nothing else changes.
    const phoneAgain = await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    assert.deepEqual(phoneAgain.pulled, [copy]);
  });

  test("a failed upload is reported and the other files still sync", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    phone.days.set("2026-11-24.md", DAY);
    phone.days.set("2026-11-25.md", DAY);
    gh.rejectPutFor.add("2026-11-24.md");
    const outcome = await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    assert.deepEqual(outcome.pushed, ["2026-11-25.md"]);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].name, "2026-11-24.md");
    assert.equal(gh.files.has("2026-11-25.md"), true);
  });

  test("an edit saved while the remote text is downloading is kept as a copy, not overwritten", async () => {
    const gh = new FakeGitHub();
    const phone = new MemoryLocal();
    const laptop = new MemoryLocal();
    phone.days.set("2026-11-25.md", DAY);
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });
    await syncDays(laptop, gh.remote(), { device: "Laptop", now: NOW });
    phone.days.set("2026-11-25.md", DAY + "- [ ] 1300 phone edit\n");
    await syncDays(phone, gh.remote(), { device: "Phone", now: NOW });

    // The laptop's user saves a new text while the sync downloads the phone's version.
    const remote = gh.remote();
    const racing = {
      list: () => remote.list(),
      put: (name: string, text: string, sha: string | null, message: string) => remote.put(name, text, sha, message),
      get: async (name: string) => {
        laptop.days.set(name, DAY + "- [ ] 1400 saved during sync\n");
        return remote.get(name);
      },
    };
    const outcome = await syncDays(laptop, racing, { device: "Laptop", now: NOW });
    assert.equal(outcome.conflicts.length, 1);
    const copy = outcome.conflicts[0].copy;
    assert.equal(laptop.days.get("2026-11-25.md"), DAY + "- [ ] 1300 phone edit\n");
    assert.equal(laptop.days.get(copy), DAY + "- [ ] 1400 saved during sync\n");
    assert.equal(gh.files.get(copy)?.text, DAY + "- [ ] 1400 saved during sync\n");
  });

  test("the conflict copy name is safe and never reuses a taken name", () => {
    const taken = new Set(["a.conflict-my-phone-20261125-101500.md"]);
    assert.equal(conflictName("a.md", "My Phone!", NOW, (name) => taken.has(name)), "a.conflict-my-phone-20261125-101500-2.md");
    assert.equal(conflictName("a.md", "", NOW, () => false), "a.conflict-device-20261125-101500.md");
  });
});

describe("reading a file whose text is not in the contents answer", () => {
  const TEXT = "25/11/2026\n- [ ] 0900 a file bigger than the contents answer carries\n";
  const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  const client = (fetcher: (url: string) => Promise<Response>) =>
    githubRepo({ owner: OWNER, repo: REPO, token: TOKEN, fetch: (url) => fetcher(String(url)) as Promise<Response> });

  test("a file over the contents limit is read through the blob API, not as empty text", async () => {
    const fetcher = async (url: string) =>
      url.includes("/git/blobs/")
        ? new Response(JSON.stringify({ encoding: "base64", content: encodeBase64(TEXT), size: TEXT.length }), { status: 200 })
        : new Response(JSON.stringify({ type: "file", name: "2026-11-25.md", sha: "b1", size: 2_000_000, encoding: "none", content: "" }), { status: 200 });
    const file = await client(fetcher).get("2026-11-25.md");
    assert.equal(file.text, TEXT);
    assert.equal(file.sha, "b1");
  });

  test("an answer with no text field is read through the blob API", async () => {
    const fetcher = async (url: string) =>
      url.includes("/git/blobs/")
        ? new Response(JSON.stringify({ encoding: "base64", content: encodeBase64(TEXT) }), { status: 200 })
        : new Response(JSON.stringify({ type: "file", name: "2026-11-25.md", sha: "b2", size: TEXT.length }), { status: 200 });
    assert.equal((await client(fetcher).get("2026-11-25.md")).text, TEXT);
  });

  test("an encoding other than base64 is refused", async () => {
    const fetcher = answer({ type: "file", name: "x.md", sha: "b3", size: 4, encoding: "utf-8", content: "abcd" });
    await assert.rejects(client(fetcher as never).get("x.md"), /unsupported encoding utf-8/);
  });

  test("a blob that is not base64 is refused", async () => {
    const fetcher = async (url: string) =>
      url.includes("/git/blobs/")
        ? new Response(JSON.stringify({ encoding: "utf-8", content: "text" }), { status: 200 })
        : new Response(JSON.stringify({ type: "file", name: "x.md", sha: "b4", size: 0, encoding: "none", content: "" }), { status: 200 });
    await assert.rejects(client(fetcher).get("x.md"), /did not return the file text/);
  });

  test("a file that does not exist is an error, never empty text", async () => {
    const fetcher = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    await assert.rejects(client(fetcher).get("gone.md"), (err: unknown) => err instanceof GitHubError && err.status === 404);
  });

  test("an empty file is empty text", async () => {
    const fetcher = answer({ type: "file", name: "e.md", sha: "b5", size: 0, encoding: "base64", content: "" });
    assert.equal((await client(fetcher as never).get("e.md")).text, "");
  });
});
