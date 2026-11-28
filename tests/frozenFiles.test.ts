import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDay } from "../src/core/parser";
import { withFrozenLine, withoutFrozenLine } from "../src/core/freeze";
import { convertFolder } from "../src/node/batch";
import { freezeFile, listSnapshots, reparseCheck, takeSnapshot } from "../src/node/freeze";

const NOW = new Date(Date.UTC(2026, 10, 11, 12));
const LATER = new Date(Date.UTC(2027, 0, 5, 12)); // a different clock year
const SNAPSHOT = "2026-11-26T10_21_02";
const SNAPSHOT_TEXT = "gym:\n  - gym\n";
const FROZEN_LINE = `# frozen: year=2026 projects=${SNAPSHOT}`;
const DAY = "#toggl 11/11\n- [ ] 0800 gym\n- [ ] 0900 X\n- [ ] \n";

function withTmp(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "tp-frozen-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

// ---- the parser skips the frozen line ----------------------------------------------------

test("the # frozen: line after the header is skipped, and entries keep their line numbers", () => {
  const frozen = parseDay(`#toggl 11/11\n${FROZEN_LINE}\n- [ ] 0800 gym\n- [ ] 0900 X\n`, { now: NOW });
  assert.deepEqual(frozen.entries.map((e) => e.line), [3, 4]);
  assert.deepEqual(frozen.entries.map((e) => e.start), ["08:00", "09:00"]);
  assert.equal(frozen.parser_version, parseDay(DAY, { now: NOW }).parser_version);
});

test("a # line after the header is a comment (issue 23), so the entries are the same with or without it", () => {
  const shape = (text: string) => parseDay(text, { now: NOW }).entries.map((e) => [e.start, e.end, e.description, e.project]);
  assert.deepEqual(shape(`#toggl 11/11\n# something else\n- [ ] 0800 gym\n`), shape(`#toggl 11/11\n- [ ] 0800 gym\n`));
});

test("the HTML form of the frozen line is a comment, so the entries are the same", () => {
  const page = "<div><br><h1> 26/10</h1></div>\n<ul>\n<li>-7:26 API review </li>\n<li>1650 be with Sam</li>\n</ul>\n";
  const framed = page.replace("</h1></div>\n", `</h1></div><!-- frozen: year=2026 projects=${SNAPSHOT} -->\n`);
  assert.deepEqual(parseDay(framed, { now: NOW }).entries, parseDay(page, { now: NOW }).entries);
});

// ---- convert: the skip decision -----------------------------------------------------------

test("convert skips a file whose JSON was made from the same inputs, and FORCE parses it again", () => {
  withTmp((root) => {
    const src = join(root, "in");
    const out = join(root, "out");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), DAY);
    const options = { projects: { gym: ["gym"] }, projectsText: SNAPSHOT_TEXT, defaultYear: 2026, now: NOW };

    const first = convertFolder(src, out, options);
    assert.equal(first.written.length, 1);
    assert.deepEqual(first.skipped, []);

    const second = convertFolder(src, out, options);
    assert.deepEqual(second.written, []);
    assert.equal(second.skipped.length, 1);

    const forced = convertFolder(src, out, { ...options, force: true });
    assert.equal(forced.written.length, 1);
    assert.deepEqual(forced.skipped, []);
  });
});

test("convert parses again when projects.yml changed", () => {
  withTmp((root) => {
    const src = join(root, "in");
    const out = join(root, "out");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), DAY);
    convertFolder(src, out, { projects: { gym: ["gym"] }, projectsText: SNAPSHOT_TEXT, defaultYear: 2026, now: NOW });

    const changed = convertFolder(src, out, {
      projects: { gym: ["gym"], X: ["X"] },
      projectsText: "gym:\n  - gym\nX:\n  - X\n",
      defaultYear: 2026,
      now: NOW,
    });
    assert.equal(changed.written.length, 1);
  });
});

test("the JSON records the projects used, their source, the hashes, the frozen flag and the year", () => {
  withTmp((root) => {
    writeFileSync(join(root, "1.md"), DAY);
    convertFolder(root, join(root, "out"), { projects: { gym: ["gym"] }, projectsText: SNAPSHOT_TEXT, defaultYear: 2026, now: NOW });
    const day = json(join(root, "out", "1.json"));
    assert.equal(day.projects_text, SNAPSHOT_TEXT);
    assert.equal(day.projects_source, "projects.yml");
    assert.match(day.projects_sha256, /^[0-9a-f]{64}$/);
    assert.match(day.input_sha256, /^[0-9a-f]{64}$/);
    assert.equal(day.frozen, false);
    assert.equal(day.year, 2026);
  });
});

// ---- a frozen file parses the same again -------------------------------------------------

test("a frozen file parsed again gives the same output except parsed_at, with another clock year and projects.yml", () => {
  withTmp((root) => {
    const src = join(root, "in");
    const snapshots = join(root, "projects-snapshots");
    mkdirSync(src);
    mkdirSync(snapshots);
    writeFileSync(join(snapshots, `${SNAPSHOT}.yml`), SNAPSHOT_TEXT);
    writeFileSync(join(src, "1.md"), `#toggl 11/11\n${FROZEN_LINE}\n- [ ] 0800 gym\n- [ ] 0900 X\n- [ ] \n`);

    convertFolder(src, join(root, "first"), {
      projects: {},
      projectsText: "",
      snapshotsDir: snapshots,
      defaultYear: 2026,
      now: NOW,
    });
    convertFolder(src, join(root, "second"), {
      projects: { gym: ["gym"], X: ["X"] },
      projectsText: "gym:\n  - gym\nX:\n  - X\n",
      snapshotsDir: snapshots,
      now: LATER,
    });

    const first = json(join(root, "first", "1.json"));
    const second = json(join(root, "second", "1.json"));
    assert.equal(first.frozen, true);
    assert.equal(first.projects_source, SNAPSHOT);
    assert.equal(first.projects_text, SNAPSHOT_TEXT);
    assert.equal(first.entries[0].project, "gym");
    const strip = ({ parsed_at: _ignored, ...rest }: Record<string, unknown>) => rest;
    assert.deepEqual(strip(second), strip(first));
  });
});

test("a frozen file whose snapshot is missing fails and names the file and the snapshot", () => {
  withTmp((root) => {
    const src = join(root, "in");
    mkdirSync(src);
    writeFileSync(join(src, "1.md"), `#toggl 11/11\n${FROZEN_LINE}\n- [ ] 0800 gym\n`);
    const result = convertFolder(src, join(root, "out"), { snapshotsDir: join(root, "none"), now: NOW });
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].message, new RegExp(SNAPSHOT));
    assert.match(result.failed[0].file, /1\.md$/);
  });
});

// ---- the freeze line in the file -----------------------------------------------------------

const MARK = { year: 2026, projects: SNAPSHOT };

test("the freeze line goes right after the header of a Markdown day, and replaces an old one", () => {
  const text = "#toggl 11/11\n- [ ] 0800 gym\n";
  assert.equal(withFrozenLine(text, MARK, false), `#toggl 11/11\n${FROZEN_LINE}\n- [ ] 0800 gym\n`);
  const old = withFrozenLine(text, { year: 2025, projects: "2025-01-01T00_00_00" }, false);
  assert.equal(withFrozenLine(old, MARK, false), `#toggl 11/11\n${FROZEN_LINE}\n- [ ] 0800 gym\n`);
});

test("the freeze line goes before the list in an HTML page, and unfreezing removes it", () => {
  const page = "<div><br><h1> 26/10</h1></div>\n<ul>\n<li>1650 be with Sam</li>\n</ul>\n";
  const framed = withFrozenLine(page, MARK, true);
  assert.equal(framed, `<div><br><h1> 26/10</h1></div>\n<!-- frozen: year=2026 projects=${SNAPSHOT} -->\n<ul>\n<li>1650 be with Sam</li>\n</ul>\n`);
  assert.equal(withoutFrozenLine(framed), page);
  assert.equal(withoutFrozenLine("#toggl 11/11\n- [ ] 0800 gym\n"), "#toggl 11/11\n- [ ] 0800 gym\n");
});

// ---- snapshots and freezing files ------------------------------------------------------------

test("a snapshot is made only when projects.yml differs from the newest one, and old ones are kept", () => {
  withTmp((root) => {
    const dir = join(root, "projects-snapshots");
    const first = takeSnapshot("gym:\n  - gym\n", dir, new Date(2026, 10, 26, 10, 0, 0));
    assert.equal(first.created, true);
    const again = takeSnapshot("gym:\n  - gym\n", dir, new Date(2026, 10, 27, 10, 0, 0));
    assert.deepEqual(again, { name: first.name, created: false });
    const changed = takeSnapshot("gym:\n  - gym\n  - fit\n", dir, new Date(2026, 10, 28, 10, 0, 0));
    assert.equal(changed.created, true);
    assert.deepEqual(listSnapshots(dir), [first.name, changed.name]);
    assert.equal(readFileSync(join(dir, `${first.name}.yml`), "utf-8"), "gym:\n  - gym\n");
  });
});

test("freezing a file writes the line and a snapshot; freezing again changes nothing; unfreezing removes the line", () => {
  withTmp((root) => {
    const projects = join(root, "data", "projects.yml");
    mkdirSync(join(root, "data"));
    writeFileSync(projects, SNAPSHOT_TEXT);
    const file = join(root, "data", "11-11.md");
    writeFileSync(file, DAY);

    const frozen = freezeFile(file, { projectsPath: projects, now: NOW });
    assert.equal(frozen.changed, true);
    assert.equal(frozen.snapshotCreated, true);
    const text = readFileSync(file, "utf-8");
    assert.match(text, /^#toggl 11\/11\n# frozen: year=2026 projects=\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}\n/);
    assert.equal(listSnapshots(join(root, "data", "projects-snapshots")).length, 1);

    const again = freezeFile(file, { projectsPath: projects, now: LATER });
    assert.equal(again.changed, false);
    assert.equal(again.snapshotCreated, false);

    const unfrozen = freezeFile(file, { projectsPath: projects, unfreeze: true });
    assert.equal(unfrozen.changed, true);
    assert.equal(readFileSync(file, "utf-8"), DAY);
  });
});

test("reparse-check reports a frozen file as the same, and a snapshot that no longer matches", () => {
  withTmp((root) => {
    const data = join(root, "data");
    mkdirSync(data);
    const projects = join(data, "projects.yml");
    writeFileSync(projects, SNAPSHOT_TEXT);
    const file = join(data, "11-11.md");
    writeFileSync(file, DAY);
    freezeFile(file, { projectsPath: projects, now: NOW });
    convertFolder(data, data, { snapshotsDir: join(data, "projects-snapshots"), now: NOW });

    assert.deepEqual(reparseCheck(data, projects).map((entry) => entry.status), ["same"]);

    const snapshot = join(data, "projects-snapshots", `${listSnapshots(join(data, "projects-snapshots"))[0]}.yml`);
    writeFileSync(snapshot, "gym:\n  - gym\n  - edited\n");
    const flagged = reparseCheck(data, projects);
    assert.equal(flagged[0].status, "snapshot-mismatch");
    assert.match(flagged[0].lines[0], /no longer matches/);
  });
});
