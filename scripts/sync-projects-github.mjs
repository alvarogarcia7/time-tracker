#!/usr/bin/env node
// Copies the project database (DB, default data/projects.yml) to the GitHub data repository, on its main branch,
// as one commit that changes only projects.yml. Never a day file, never a force push.
//
// It refuses, and changes nothing, when the GitHub copy has a project that the local file lacks: that
// would delete it on GitHub. Set SYNC_ALLOW_REMOVE=1 to allow that once.
//
//   node scripts/sync-projects-github.mjs [DB]
//   REMOTE=<url or path> overrides the data repository (used by the tests).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REMOTE = process.env.REMOTE || "https://github.com/alvarogarcia7/time-tracker-data.git";
const BRANCH = "main";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const db = process.argv[2] || join(root, "data", "projects.yml");
const work = join(root, "build", "github-data");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function projectNames(text) {
  const data = parse(text) ?? {};
  return new Set(Object.keys(data));
}

function fail(message) {
  console.error(`github: ${message}`);
  process.exit(1);
}

if (!existsSync(db)) fail(`no ${db}`);
const localText = readFileSync(db, "utf8");
projectNames(localText); // the local file must parse before anything is sent

// A fresh clone each time keeps the GitHub copy the source of truth for the comparison.
rmSync(work, { recursive: true, force: true });
mkdirSync(dirname(work), { recursive: true });
try {
  git(["clone", "-q", "--branch", BRANCH, REMOTE, work], root);
} catch (err) {
  fail(`clone failed (${String(err.stderr || err.message).trim().split("\n").pop()})`);
}

const remoteFile = join(work, "projects.yml");
const remoteText = existsSync(remoteFile) ? readFileSync(remoteFile, "utf8") : "";
const local = projectNames(localText);
const remote = remoteText ? projectNames(remoteText) : new Set();
const missing = [...remote].filter((name) => !local.has(name));
if (missing.length && process.env.SYNC_ALLOW_REMOVE !== "1") {
  fail(`refused: GitHub has ${missing.length} project(s) the local file lacks (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}). Pushing would delete them on GitHub. Merge them into the local file, or set SYNC_ALLOW_REMOVE=1 to allow it once.`);
}

copyFileSync(db, remoteFile);
git(["add", "projects.yml"], work);
if (git(["status", "--porcelain"], work).trim() === "") {
  console.log("github: projects.yml already the same on GitHub; nothing to push");
  process.exit(0);
}
git(["-c", "user.name=time-parser sync", "-c", "user.email=sync@time-parser.invalid", "commit", "-q",
  "-m", "Sync projects.yml from the time-parser project database",
  "-m", "Only projects.yml changed; day files are never pushed here."], work);
try {
  git(["push", "-q", "origin", BRANCH], work); // no --force: a rejected push is reported, not forced
} catch (err) {
  fail(`push refused (${String(err.stderr || err.message).trim().split("\n").pop()}); nothing was forced`);
}
console.log(`github: projects.yml pushed to ${REMOTE} (${BRANCH})`);
