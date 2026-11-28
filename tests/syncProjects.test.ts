import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/sync-projects-github.mjs, against a throwaway bare repository standing in for the GitHub data repo.

const SCRIPT = join(process.cwd(), "scripts", "sync-projects-github.mjs");

function remoteWith(projects: string): { dir: string; remote: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "tp-sync-"));
  const remote = join(dir, "data.git");
  const seed = join(dir, "seed");
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-q", "--bare", "-b", "main", remote], dir);
  git(["init", "-q", "-b", "main", seed], dir);
  writeFileSync(join(seed, "projects.yml"), projects);
  git(["add", "projects.yml"], seed);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "-q", "origin", "main"], seed);
  return { dir, remote, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(remote: string, localText: string, env: Record<string, string> = {}) {
  const localDir = mkdtempSync(join(tmpdir(), "tp-local-"));
  const db = join(localDir, "projects.yml");
  writeFileSync(db, localText);
  const result = spawnSync(process.execPath, [SCRIPT, db], {
    env: { ...process.env, REMOTE: remote, ...env },
    encoding: "utf8",
  });
  rmSync(localDir, { recursive: true, force: true });
  return result;
}

function remoteFile(remote: string): string {
  const out = execFileSync("git", ["--git-dir", remote, "show", "main:projects.yml"], { encoding: "utf8" });
  return out;
}

const TWO = "gym:\n  keywords: [gym]\nkitchen:\n  keywords: [kitchen]\n";
const THREE = TWO + "car:\n  keywords: [car]\n";

test("a local file that adds projects is pushed, as one commit that changes only projects.yml", () => {
  const r = remoteWith(TWO);
  try {
    const result = run(r.remote, THREE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pushed/);
    assert.equal(remoteFile(r.remote), THREE);
    const files = execFileSync("git", ["--git-dir", r.remote, "show", "--name-only", "--format=", "main"], { encoding: "utf8" });
    assert.equal(files.trim(), "projects.yml");
  } finally {
    r.cleanup();
  }
});

test("a local file that lacks a project GitHub has is refused, and nothing changes on GitHub", () => {
  const r = remoteWith(THREE);
  try {
    const result = run(r.remote, TWO);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused: GitHub has 1 project\(s\) the local file lacks \(car\)/);
    assert.equal(remoteFile(r.remote), THREE);
  } finally {
    r.cleanup();
  }
});

test("SYNC_ALLOW_REMOVE=1 allows the removal once", () => {
  const r = remoteWith(THREE);
  try {
    const result = run(r.remote, TWO, { SYNC_ALLOW_REMOVE: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(remoteFile(r.remote), TWO);
  } finally {
    r.cleanup();
  }
});

test("an unchanged database is not pushed again", () => {
  const r = remoteWith(TWO);
  try {
    const result = run(r.remote, TWO);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to push/);
  } finally {
    r.cleanup();
  }
});

test("an unreachable GitHub is reported and the script fails, without touching the local file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-missing-"));
  try {
    const result = run(join(dir, "nope.git"), TWO);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /clone failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The Makefile dry run: no command runs, so no network is touched.
function dryRun(target: string): string {
  return execFileSync("make", ["-n", target], { cwd: process.cwd(), encoding: "utf8" });
}

test("make save only saves: its dry run has no GitHub step", () => {
  const save = dryRun("save");
  assert.match(save, /git commit/);
  assert.doesNotMatch(save, /sync-projects-github/);
  assert.doesNotMatch(save, /\bnode\b/);
});

test("make sync lists the save, the GitLab push and the GitHub sync", () => {
  const sync = dryRun("sync");
  assert.match(sync, /git commit/);
  assert.match(sync, /git push origin/);
  assert.match(sync, /node scripts\/sync-projects-github\.mjs/);
});
