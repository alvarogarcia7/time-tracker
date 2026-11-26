import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli";
import { PARSER_VERSION, SCHEMA_REFERENCE } from "../src/core/version";

const ROOT = join(__dirname, "..");
const EXAMPLES = join(ROOT, "tests", "fixtures", "sample");
const EXAMPLE = "#toggl 11/11\n- [ ] 8 X\n- [ ] 859 watch tv, lost\n- [ ] -1:00 8\n- [ ] 1106 gym\n- [ ]\n";

// Runs the command with stdout and stderr collected.
function run(...argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: main(argv), out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

function withTmp(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tp-cli-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parse prints the parsed day for each example, equal to the expected output except the parse time", () => {
  for (const day of readdirSync(EXAMPLES).filter((name) => name.endsWith(".md"))) {
    const { code, out } = run("parse", join(EXAMPLES, day), "--projects", join(EXAMPLES, "projects.yml"), "--year", "2026");
    const actual = JSON.parse(out);
    const expected = JSON.parse(readFileSync(join(EXAMPLES, "expected", day.replace(/\.md$/, ".json")), "utf-8"));

    assert.equal(code, 0, day);
    delete actual.parsed_at;
    delete expected.parsed_at;
    assert.deepEqual(actual, expected, day);
    assert.equal(actual.schema, SCHEMA_REFERENCE);
  }
});

test("parse with a file that is missing exits 1", () => {
  const { code, err } = run("parse", "/nonexistent/day.md");

  assert.equal(code, 1);
  assert.match(err, /error:/);
});

test("parse of an invalid day exits 1 and names the line", () => {
  withTmp((dir) => {
    const path = join(dir, "bad.md");
    writeFileSync(path, "#toggl 11/11\n- [ ] 2500 a\n");

    const { code, err } = run("parse", path);

    assert.equal(code, 1);
    assert.match(err, /line 2/);
  });
});

test("convert writes JSON next to the input by default and reports failures with exit 1", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "1.md"), "#toggl 11/11\n- [ ] 0800 a\n");
    writeFileSync(join(dir, "2.md"), "#toggl 11/11\n- [ ] 2500 b\n");

    const { code, out, err } = run("convert", dir, "--year", "2026");

    assert.equal(code, 1);
    assert.match(out, /Converted 1 file\(s\)/);
    assert.match(out, /1 failed/);
    assert.match(err, /2\.md/);
    assert.ok(readdirSync(dir).includes("1.json"));
  });
});

test("convert with a pattern converts only those files", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "1.txt"), "#toggl 11/11\n- [ ] 0800 a\n");

    const { code } = run("convert", dir, "--pattern", "*.txt", "--year", "2026");

    assert.equal(code, 0);
    assert.ok(readdirSync(dir).includes("1.json"));
  });
});

test("view prints a parser output file as text", () => {
  const { code, out } = run("view", join(EXAMPLES, "expected", "week-day.json"), "--view", "projects");

  assert.equal(code, 0);
  assert.match(out, /gym  \(1h 30m, 2 entries\)/);
});

test("view of a file that is not a day exits 1", () => {
  withTmp((dir) => {
    const path = join(dir, "other.json");
    writeFileSync(path, "[1, 2]");

    const { code, err } = run("view", path);

    assert.equal(code, 1);
    assert.match(err, /Not a time-entry file/);
  });
});

test("report as JSON for the sample days", () => {
  const { code, out } = run(
    "report",
    join(EXAMPLES, "expected"),
    "--db",
    join(EXAMPLES, "projects.yml"),
    "--period",
    "daily",
    "--format",
    "json",
  );
  const report = JSON.parse(out);

  assert.equal(code, 0);
  assert.equal(report.totals.hours, 6.6);
  assert.equal(report.totals.open_entries, 2);
  assert.deepEqual(report.by_period.map((p: { period: string }) => p.period), ["2026-11-11", "2026-11-12"]);
});

test("report as text has both tables", () => {
  const { code, out } = run("report", join(EXAMPLES, "expected"), "--db", join(EXAMPLES, "projects.yml"), "--period", "monthly");

  assert.equal(code, 0);
  assert.match(out, /Hours per period/);
  assert.match(out, /Hours per project/);
  assert.match(out, /personal/);
});

test("project and prefix arguments accept commas", () => {
  const { code, out } = run(
    "report",
    join(EXAMPLES, "expected"),
    "--db",
    join(EXAMPLES, "projects.yml"),
    "--project",
    "gym,lost",
    "--format",
    "json",
  );

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out).by_project.map((p: { project: string }) => p.project).sort(), ["gym", "lost"]);
});

test("a report with an unknown project exits 1", () => {
  const { code, err } = run("report", join(EXAMPLES, "expected"), "--db", join(EXAMPLES, "projects.yml"), "--project", "gmy");

  assert.equal(code, 1);
  assert.match(err, /unknown project "gmy"/);
});

test("report without --db is a usage error", () => {
  const { code, err } = run("report", join(EXAMPLES, "expected"));

  assert.equal(code, 2);
  assert.match(err, /--db is required/);
});

test("suggest adds unregistered projects, and a second run adds nothing", () => {
  withTmp((dir) => {
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "1.md"), "#toggl 11/11\n- [ ] 0800 Cooking\n- [ ] 0900 gym\n- [ ] \n");
    const db = join(dir, "projects.yml");
    writeFileSync(db, "gym:\n  keywords: [gym]\n");
    run("convert", data, "--year", "2026");

    const first = run("suggest", data, "--db", db);
    const once = readFileSync(db, "utf-8");
    const second = run("suggest", data, "--db", db);

    assert.match(first.out, /Wrote 1 unregistered project/);
    assert.match(once, /#Cooking:/);
    assert.match(second.out, /Wrote 0 unregistered project/);
    assert.equal(readFileSync(db, "utf-8"), once);
  });
});

test("an unknown command is a usage error, and help lists the commands", () => {
  assert.equal(run("nothing").code, 2);
  const help = run("help");
  assert.equal(help.code, 0);
  assert.match(help.out, /convert IN_DIR/);
  assert.match(help.out, /editor FOLDER/);
});

test("the example day from the README parses from a file with a tag", () => {
  withTmp((dir) => {
    const path = join(dir, "day.md");
    writeFileSync(path, EXAMPLE);

    const { code, out } = run("parse", path, "--year", "2026");

    assert.equal(code, 0);
    assert.equal(JSON.parse(out).entries.length, 4);
  });
});

test("the parser version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

  assert.equal(PARSER_VERSION, pkg.version);
});
