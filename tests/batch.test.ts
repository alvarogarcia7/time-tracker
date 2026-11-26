import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { convertFolder } from "../src/node/batch";
import { keywordsOf } from "../src/core/reports";
import { loadDatabaseFile } from "../src/node/projectsFile";

const ROOT = join(__dirname, "..");
const NOW = new Date(Date.UTC(2026, 10, 11, 12));
const GOOD = "#toggl 11/11\n- [ ] 0800 gym\n- [ ] 0900 X\n- [ ] \n";
const BAD = "#toggl 11/11\n- [ ] 2500 broken\n";
const PAGE = "<div><br><h1> 26/10</h1></div>\n<ul>\n<li>-7:26 API review </li>\n<li>1650 be with Sam</li>\n<li>-1:11 API review</li>\n<li>19:39 gym</li>\n</ul>\n";

function withTmp(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "tp-batch-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

// ---- batch ----------------------------------------------------------------------------

test("each day file becomes JSON with the same name", () => {
  withTmp((root) => {
    const src = join(root, "in");
    const out = join(root, "out");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), GOOD);
    writeFileSync(join(src, "2.md"), GOOD);

    const result = convertFolder(src, out, { defaultYear: 2026, now: NOW });

    assert.deepEqual(result.written.map((p) => p.split("/").pop()), ["1.json", "2.json"]);
    assert.deepEqual(result.failed, []);
    const day = json(join(out, "1.json"));
    assert.equal(day.date, "2026-11-11");
    assert.equal(day.entries.length, 2);
  });
});

test("only matching files are converted (default: md and html)", () => {
  withTmp((root) => {
    writeFileSync(join(root, "1.md"), GOOD);
    writeFileSync(join(root, "projects.yaml"), "gym: [gym]\n");
    writeFileSync(join(root, "notes.txt"), "hello");

    const result = convertFolder(root, root, { defaultYear: 2026, now: NOW });

    assert.deepEqual(result.written.map((p) => p.split("/").pop()), ["1.json"]);
    assert.ok(!existsSync(join(root, "projects.json")));
  });
});

test("html pages are converted by default", () => {
  withTmp((root) => {
    writeFileSync(join(root, "26-10.html"), PAGE);

    const result = convertFolder(root, join(root, "out"), { defaultYear: 2026, now: NOW });

    assert.equal(result.written.length, 1);
    assert.equal(json(join(root, "out", "26-10.json")).date, "2026-10-26");
  });
});

test("a bad file is reported and the rest still convert", () => {
  withTmp((root) => {
    const src = join(root, "in");
    const out = join(root, "out");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), GOOD);
    writeFileSync(join(src, "2.md"), BAD);
    writeFileSync(join(src, "3.md"), GOOD);

    const result = convertFolder(src, out, { defaultYear: 2026, now: NOW });

    assert.deepEqual(result.written.map((p) => p.split("/").pop()), ["1.json", "3.json"]);
    assert.equal(existsSync(join(out, "2.json")), false);
    assert.deepEqual(result.failed.map((f) => f.file.split("/").pop()), ["2.md"]);
    assert.match(result.failed[0].message, /line 2/);
  });
});

test("projects are applied", () => {
  withTmp((root) => {
    writeFileSync(join(root, "1.md"), GOOD);

    convertFolder(root, join(root, "out"), { projects: { gym: ["gym"] }, defaultYear: 2026, now: NOW });

    assert.deepEqual(json(join(root, "out", "1.json")).entries.map((e: { project: string }) => e.project), ["gym", "unknown"]);
  });
});

test("a missing input folder is rejected", () => {
  withTmp((root) => {
    assert.throws(() => convertFolder(join(root, "nowhere"), join(root, "out")), /not a folder/);
  });
});

test("the output folder is created", () => {
  withTmp((root) => {
    const src = join(root, "in");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), GOOD);

    convertFolder(src, join(root, "a", "b"), { defaultYear: 2026, now: NOW });

    assert.ok(existsSync(join(root, "a", "b", "1.json")));
  });
});

test("the example days convert into a temporary output", () => {
  withTmp((root) => {
    const result = convertFolder(join(ROOT, "tests", "fixtures", "sample"), root, {
      projects: Object.fromEntries(keywordsOf(loadDatabaseFile(join(ROOT, "tests", "fixtures", "sample", "projects.yml")))),
      defaultYear: 2026,
    });

    assert.equal(result.failed.length, 0);
    assert.deepEqual(readdirSync(root).sort(), ["day.json", "week-day.json"]);
  });
});
