import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { TimeParseError, detectProject, parseDay, validateProjects, PARSER_VERSION, SCHEMA_REFERENCE } from "../src/core/parser";
import { keywordsOf, loadDatabase } from "../src/core/reports";

const ROOT = join(__dirname, "..");
const EXAMPLES = join(ROOT, "tests", "fixtures", "sample");
const NOW = new Date(Date.UTC(2026, 10, 11, 8, 0));
const PARSED_AT = "2026-11-11T12:00:00+04:00";

const EXAMPLE = "#toggl 11/11\n- [ ] 8 X\n- [ ] 859 watch tv, lost\n- [ ] -1:00 8\n- [ ] 1106 gym\n- [ ]\n";
const PROJECTS = { lost: ["lost"], gym: ["gym"] };

const parse = (text: string, options: Parameters<typeof parseDay>[1] = {}) =>
  parseDay(text, { parsedAt: PARSED_AT, defaultYear: 2026, ...options });
const dayWith = (...tasks: string[]) => ["#toggl 11/11", ...tasks].join("\n") + "\n";

// Projects from YAML text, the way the database is read.
const keywordsFromYaml = (text: string) => Object.fromEntries(keywordsOf(loadDatabase(text)));

const expectThrows = (fn: () => unknown, pattern?: RegExp) => {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof TimeParseError, `expected TimeParseError, got ${String(err)}`);
    if (pattern) assert.match((err as Error).message, pattern);
    return true;
  });
};

// ---- the example and the output --------------------------------------------

test("the example gives the entries, with the relative time resolved", () => {
  const entries = parse(EXAMPLE, { projects: PROJECTS }).entries;

  assert.deepEqual(
    entries.map((e) => [e.start, e.end, e.description, e.project]),
    [
      ["08:00", "08:59", "X", "unknown"],
      ["08:59", "10:06", "watch tv, lost", "lost"],
      ["10:06", "11:06", "X", "unknown"],
      ["11:06", null, "gym", "gym"],
    ],
  );
});

test("a relative entry refers to the absolute entry it copies", () => {
  const relative = parse(EXAMPLE, { projects: PROJECTS }).entries[2];

  assert.equal(relative.start_type, "relative");
  assert.equal(relative.time_expression, "-1:00");
  assert.deepEqual(relative.reference, { start: "08:00", line: 2 });
  assert.equal(relative.duration_minutes, 60);
});

test("changing the relative offset is computed", () => {
  const entries = parse(EXAMPLE.replace("-1:00 8", "-1:10 8"), { projects: PROJECTS }).entries;

  assert.equal(entries[1].start, "08:59");
  assert.equal(entries[1].end, "09:56");
  assert.equal(entries[2].start, "09:56");
  assert.equal(entries[2].end, "11:06");
  assert.equal(entries[2].description, "X");
});

test("the day fields", () => {
  const result = parse(EXAMPLE, { projects: PROJECTS });

  assert.equal(result.date, "2026-11-11");
  assert.equal(result.tag, "toggl");
  assert.equal(result.parsed_at, PARSED_AT);
  assert.equal(result.original_text, EXAMPLE);
  assert.equal(result.parser_version, PARSER_VERSION);
  assert.equal(result.schema, SCHEMA_REFERENCE);
});

test("the default parse time is the local time with its offset", () => {
  const result = parseDay(dayWith("- [ ] 0800 a"), { now: NOW, defaultYear: 2026 });

  assert.match(result.parsed_at, /^2026-11-11T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

// ---- golden outputs: the sample days against their hand-written expected JSON -------

test("each example day matches its expected output", () => {
  const projects = keywordsFromYaml(readFileSync(join(EXAMPLES, "projects.yml"), "utf-8"));
  const days = readdirSync(EXAMPLES).filter((name) => name.endsWith(".md")).sort();
  assert.ok(days.length >= 2);
  for (const day of days) {
    const stem = day.replace(/\.md$/, "");
    const expected = JSON.parse(readFileSync(join(EXAMPLES, "expected", `${stem}.json`), "utf-8"));
    const actual = parse(readFileSync(join(EXAMPLES, day), "utf-8"), { projects });
    assert.deepEqual(actual, expected, day);
  }
});

test("the schema file describes the output keys", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, SCHEMA_REFERENCE), "utf-8"));
  const result = parse(EXAMPLE, { projects: PROJECTS });

  assert.deepEqual([...schema.required].sort(), Object.keys(result).sort());
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(result).sort());
  assert.equal(schema.properties.schema.type, "string");
  assert.equal(schema.version, "1.2.0");
  assert.equal(schema.$id, SCHEMA_REFERENCE);
});

// ---- absolute times -----------------------------------------------------------------

test("accepted absolute time forms", () => {
  const cases: Record<string, string> = {
    "8": "08:00",
    "08": "08:00",
    "10": "10:00",
    "100": "01:00",
    "859": "08:59",
    "0859": "08:59",
    "1106": "11:06",
    "1000": "10:00",
    "2359": "23:59",
    "8:59": "08:59",
    "08:59": "08:59",
    "8:00": "08:00",
    "23:00": "23:00",
  };
  for (const [token, expected] of Object.entries(cases)) {
    const entry = parse(dayWith(`- [ ] ${token} work`)).entries[0];
    assert.equal(entry.start, expected, token);
    assert.equal(entry.start_type, "absolute");
    assert.equal(entry.time_expression, token);
  }
});

test("invalid absolute times are rejected", () => {
  for (const token of ["25", "2400", "1260", "8:60", "8:5", "12345", "abc", "1:2:3"]) {
    expectThrows(() => parse(dayWith(`- [ ] ${token} work`)), undefined);
  }
});

// ---- relative times -----------------------------------------------------------------

test("minus is before the next absolute entry", () => {
  const entries = parse(dayWith("- [ ] -0:30 coffee", "- [ ] 0900 meeting")).entries;

  assert.equal(entries[0].start, "08:30");
  assert.equal(entries[0].end, "09:00");
  assert.equal(entries[0].start_type, "relative");
});

test("plus is after the previous entry's start", () => {
  const entries = parse(dayWith("- [ ] 0800 coffee", "- [ ] +0:45 meeting")).entries;

  assert.equal(entries[1].start, "08:45");
  assert.equal(entries[1].start_type, "relative");
});

test("a bare number is minutes", () => {
  const entries = parse(dayWith("- [ ] -30 coffee", "- [ ] 0900 meeting", "- [ ] +15 walk")).entries;

  assert.equal(entries[0].start, "08:30");
  assert.equal(entries[2].start, "09:15");
});

test("a bare number above sixty is still minutes", () => {
  const entries = parse(dayWith("- [ ] -100 lunch", "- [ ] 1300 nap")).entries;

  assert.equal(entries[0].start, "11:20");
  assert.equal(entries[0].duration_minutes, 100);
});

test("a colon duration is hours and minutes", () => {
  const entries = parse(dayWith("- [ ] -1:30 lunch", "- [ ] 1300 nap")).entries;

  assert.equal(entries[0].start, "11:30");
  assert.equal(entries[0].duration_minutes, 90);
});

test("plus with a colon duration is hours and minutes", () => {
  const entries = parse(dayWith("- [ ] 0800 coffee", "- [ ] +1:30 meeting")).entries;

  assert.equal(entries[1].start, "09:30");
});

test("a relative time before midnight is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] -5:00 late", "- [ ] 0300 early")), /outside the day/);
});

test("minus without a following absolute time is rejected, with its line", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a", "- [ ] -1:00 b")), /line 3/);
});

test("plus without a previous entry is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] +1:00 a", "- [ ] 0900 b")));
});

test("invalid relative forms are rejected", () => {
  for (const token of ["-", "+", "-abc", "-1:60", "--1:00"]) {
    expectThrows(() => parse(dayWith("- [ ] 0800 a", `- [ ] ${token} b`, "- [ ] 1000 c")));
  }
});

test("a relative entry that passes midnight is accepted", () => {
  const entries = parse(dayWith("- [ ] 2300 a", "- [ ] -0:10 b", "- [ ] 0030 c")).entries;

  assert.deepEqual([entries[1].start, entries[1].end, entries[1].duration_minutes], ["00:20", "00:30", 10]);
  assert.equal(entries[0].duration_minutes, 80);
});

// ---- ordering -----------------------------------------------------------------------

test("an entry may pass midnight: it may finish after 00:00 on the next day", () => {
  const entries = parse(dayWith("- [ ] 2334 API review", "- [ ] 0313 sleep")).entries;

  assert.deepEqual(
    entries.map((e) => [e.start, e.end, e.duration_minutes]),
    [
      ["23:34", "03:13", 219],
      ["03:13", null, null],
    ],
  );
});

test("a clock that goes back only once per file", () => {
  expectThrows(() => parse(dayWith("- [ ] 2300 a", "- [ ] 0030 b", "- [ ] 2200 c", "- [ ] 0100 d")), /line 5|only one entry may pass midnight/);
});

test("entries may share a start time", () => {
  const entries = parse(dayWith("- [ ] 0900 a", "- [ ] 0900 b")).entries;

  assert.equal(entries[0].end, "09:00");
  assert.equal(entries[0].duration_minutes, 0);
});

test("an entry may pass midnight only when the entry before it starts after 21:00", () => {
  expectThrows(() => parse(dayWith("- [ ] 1100 a", "- [ ] 1030 b")), /line 3.*after 21:00/);
  expectThrows(() => parse(dayWith("- [ ] 2100 a", "- [ ] 0030 b")), /after 21:00/);
  const entries = parse(dayWith("- [ ] 2101 a", "- [ ] 0030 b")).entries;
  assert.equal(entries[0].duration_minutes, 209);
});

test("the entries before and after midnight keep their order", () => {
  const entries = parse(dayWith("- [ ] 2300 late", "- [ ] 0030 after midnight", "- [ ] 0100 more")).entries;

  assert.deepEqual(entries.map((e) => e.duration_minutes), [90, 30, null]);
});

// ---- references ---------------------------------------------------------------------

test("a reference copies the description", () => {
  const entries = parse(dayWith("- [ ] 0800 X", "- [ ] 0900 8")).entries;

  assert.equal(entries[1].description, "X");
  assert.deepEqual(entries[1].reference, { start: "08:00", line: 2 });
  assert.equal(entries[0].reference, null);
});

test("a chain of references is resolved", () => {
  const entries = parse(dayWith("- [ ] 0800 X", "- [ ] 0900 8", "- [ ] 1000 9")).entries;

  assert.equal(entries[2].description, "X");
  assert.deepEqual(entries[2].reference, { start: "09:00", line: 3 });
});

test("a reference matches the resolved start", () => {
  const entries = parse(dayWith("- [ ] 0800 X", "- [ ] -0:30 Y", "- [ ] 0900 0830")).entries;

  assert.equal(entries[1].start, "08:30");
  assert.equal(entries[2].description, "Y");
});

test("a reference to a missing time is rejected, with its line", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 X", "- [ ] 0900 0700")), /line 3/);
});

test("a reference to a later entry is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 9", "- [ ] 0900 Y")));
});

test("a reference to itself is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 8")));
});

test("a time inside a description is not a reference", () => {
  const entry = parse(dayWith("- [ ] 0800 10 km run")).entries[0];

  assert.equal(entry.description, "10 km run");
  assert.equal(entry.reference, null);
});

test("a reference uses the nearest earlier entry", () => {
  const entries = parse(dayWith("- [ ] 0800 first", "- [ ] 0800 second", "- [ ] 0900 8")).entries;

  assert.equal(entries[2].description, "second");
  assert.equal(entries[2].reference?.line, 3);
});

// ---- projects -----------------------------------------------------------------------

test("a keyword matches a whole word, ignoring case", () => {
  assert.equal(detectProject("watch TV, Lost", new Map(Object.entries(PROJECTS))), "lost");
  assert.equal(detectProject("lost and found", new Map(Object.entries(PROJECTS))), "lost");
});

test("a keyword inside another word does not match", () => {
  const projects = new Map(Object.entries(PROJECTS));

  assert.equal(detectProject("lostness", projects), "unknown");
  assert.equal(detectProject("gymnastics", projects), "unknown");
});

test("no match is unknown", () => {
  assert.equal(detectProject("X", new Map(Object.entries(PROJECTS))), "unknown");
  assert.equal(detectProject("anything", new Map()), "unknown");
});

test("a description matching two projects is rejected", () => {
  const projects = new Map([["first", ["shared"]], ["second", ["other"]]]);

  expectThrows(() => detectProject("shared other", projects), /first, second/);
});

test("the ambiguous entry reports its line", () => {
  expectThrows(
    () => parse(dayWith("- [ ] 0800 shared other"), { projects: { first: ["shared"], second: ["other"] } }),
    /line 2/,
  );
});

test("a multi-word keyword", () => {
  assert.equal(detectProject("call Client-A Team", new Map([["client", ["client-a team"]]])), "client");
});

test("a keyword belongs to one project only", () => {
  expectThrows(() => validateProjects({ gym: ["workout"], fitness: ["workout"] }), /'workout' maps to both 'gym' and 'fitness'/);
});

test("a keyword collision ignores case and spaces", () => {
  expectThrows(() => validateProjects({ gym: ["Gym"], fitness: [" gym "] }));
});

test("a keyword listed twice in one project is rejected", () => {
  expectThrows(() => validateProjects({ gym: ["gym", "GYM"] }), /listed twice/);
});

test("a blank keyword is rejected", () => {
  expectThrows(() => validateProjects({ all: ["  "] }), /must not be blank/);
});

test("a string keyword is one keyword", () => {
  assert.deepEqual(validateProjects({ lost: "lost" }), new Map([["lost", ["lost"]]]));
});

test("unknown is a reserved project name", () => {
  expectThrows(() => validateProjects({ unknown: ["x"] }), /reserved/);
});

test("parseDay enforces keyword ownership", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a"), { projects: { gym: ["x"], fitness: ["x"] } }));
});

test("the project comes from the resolved description", () => {
  const entries = parse(dayWith("- [ ] 0800 gym", "- [ ] 0900 8"), { projects: PROJECTS }).entries;

  assert.equal(entries[1].project, "gym");
});

test("the database loads keywords per project", () => {
  assert.deepEqual(keywordsFromYaml("lost:\n  - lost\ngym:\n  - gym\n  - workout\n"), {
    lost: ["lost"],
    gym: ["gym", "workout"],
  });
  assert.deepEqual(keywordsFromYaml(""), {});
});

test("a repeated project key is rejected", () => {
  expectThrows(() => keywordsFromYaml("gym:\n  - gym\ngym:\n  - workout\n"), /unique/i);
});

test("a keyword shared between projects is rejected by the database loader", () => {
  expectThrows(() => keywordsFromYaml("gym:\n  - workout\nfitness:\n  - workout\n"), /maps to both/);
});

test("an unquoted no is rejected as a project name (YAML 1.1 reads it as false)", () => {
  expectThrows(() => keywordsFromYaml("no:\n  - nope\n"));
});

test("a keyword that is not a string is rejected", () => {
  expectThrows(() => keywordsFromYaml("gym:\n  - 42\n"));
});

test("invalid YAML is rejected", () => {
  expectThrows(() => keywordsFromYaml("gym: [unclosed\n"));
});

test("the example database and the example days parse", () => {
  const projects = keywordsFromYaml(readFileSync(join(EXAMPLES, "projects.yml"), "utf-8"));

  assert.equal(projects.gym?.[0], "gym");
  for (const day of readdirSync(EXAMPLES).filter((name) => name.endsWith(".md"))) {
    assert.ok(parse(readFileSync(join(EXAMPLES, day), "utf-8"), { projects }).entries.length > 0, day);
  }
});

test("the conflicting example database is rejected", () => {
  expectThrows(() => loadDatabase(readFileSync(join(EXAMPLES, "projects-conflict.yaml"), "utf-8"), "projects-conflict.yaml"));
});

// ---- headers ------------------------------------------------------------------------

test("day then month", () => {
  assert.equal(parse(dayWith("- [ ] 0800 a").replace("11/11", "12/01")).date, "2026-01-12");
});

test("an explicit year in the header", () => {
  assert.equal(parse(dayWith("- [ ] 0800 a").replace("11/11", "11/11/2025")).date, "2025-11-11");
});

test("the default year argument", () => {
  assert.equal(parseDay(dayWith("- [ ] 0800 a"), { defaultYear: 2030, parsedAt: PARSED_AT }).date, "2030-11-11");
});

test("the default year comes from the parse time", () => {
  const result = parseDay(dayWith("- [ ] 0800 a"), { now: new Date(2027, 0, 1, 12), parsedAt: PARSED_AT });

  assert.equal(result.date, "2027-11-11");
});

test("an invalid date is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a").replace("11/11", "31/02")), /invalid date/);
});

test("a missing header is rejected", () => {
  expectThrows(() => parse("- [ ] 0800 a\n"), /missing header|expected a header/);
});

test("header forms: tag with or without #, any case, and text after the date", () => {
  const forms: [string, string][] = [
    ["#toggl 11/11", "toggl"],
    ["#Toggl 11/11", "Toggl"],
    ["toggl 11/11", "toggl"],
    ["toggle 11/11", "toggle"],
    ["# Toggl 11/11 Partial", "Toggl"],
  ];
  for (const [header, tag] of forms) {
    const result = parse(dayWith("- [ ] 0800 a").replace("#toggl 11/11", header));
    assert.equal(result.tag, tag, header);
    assert.equal(result.date, "2026-11-11", header);
  }
});

test("a malformed header is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a").replace("#toggl 11/11", "toggl 11-11")));
});

test("a second header is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a", "#toggl 12/11", "- [ ] 0900 b")), /only one day/);
});

test("empty input is rejected", () => {
  expectThrows(() => parse("\n  \n"));
});

// ---- line format --------------------------------------------------------------------

test("checkbox states and bullets", () => {
  const entries = parse(dayWith("- [x] 0800 a", "- [X] 0900 b", "* [ ] 1000 c", "- 1100 d")).entries;

  assert.deepEqual(entries.map((e) => e.description), ["a", "b", "c", "d"]);
});

test("blank lines and the empty placeholder are ignored", () => {
  const entries = parse("\n#toggl 11/11\n\n- [ ] 0800 a\n\n- [ ] \n- [ ]\n").entries;

  assert.equal(entries.length, 1);
  assert.equal(entries[0].end, null);
});

test("a time without a description", () => {
  const entry = parse(dayWith("- [ ] 0800")).entries[0];

  assert.equal(entry.description, "");
  assert.equal(entry.project, "unknown");
});

test("source and line numbers", () => {
  const entries = parse(dayWith("- [ ] 0800 a", "- [ ] 0900 b")).entries;

  assert.equal(entries[0].line, 2);
  assert.equal(entries[1].line, 3);
  assert.equal(entries[1].source, "- [ ] 0900 b");
});

test("a line that is not a task is rejected, with its line number", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a", "just a note")), /line 3/);
});

test("no entries is rejected", () => {
  expectThrows(() => parse(dayWith("- [ ] ")), /no time entries/);
});

test("consecutive minus entries are chained backwards from the absolute entry after them", () => {
  const entries = parse(dayWith("- [ ] 0800 a", "- [ ] -0:30 b", "- [ ] -0:10 c", "- [ ] 0900 d")).entries;

  assert.deepEqual(
    entries.map((e) => [e.start, e.end, e.duration_minutes]),
    [
      ["08:00", "08:20", 20],
      ["08:20", "08:50", 30],
      ["08:50", "09:00", 10],
      ["09:00", null, null],
    ],
  );
});

test("a run of minus entries must end at an absolute entry", () => {
  expectThrows(() => parse(dayWith("- [ ] 0800 a", "- [ ] -0:30 b", "- [ ] -0:10 c")), /line 4.*following absolute/);
});

test("the 7/11 day: the minus entries before 17:12 are chained", () => {
  const text = [
    "<h1>#toggl 7/11</h1>",
    "<ul>",
    "<li>930 watch tv, Fil</li>",
    "<li>-1:16 API review</li>",
    "<li>12 kitchen, time entries</li>",
    "<li>1210 tv</li>",
    "<li>-0:45 tv again, couple</li>",
    "<li>-1:10 nap</li>",
    "<li>-0:36 help Sam with her spreadsheet</li>",
    "<li>1712 API review</li>",
    "</ul>",
  ].join("\n");
  const entries = parse(text).entries;

  assert.deepEqual(
    entries.map((e) => [e.start, e.end, e.duration_minutes]),
    [
      ["09:30", "10:44", 74],
      ["10:44", "12:00", 76],
      ["12:00", "12:10", 10],
      ["12:10", "14:41", 151],
      ["14:41", "15:26", 45],
      ["15:26", "16:36", 70],
      ["16:36", "17:12", 36],
      ["17:12", null, null],
    ],
  );
});

test("a heading marker without a tag is a header: # 17/11", () => {
  for (const header of ["# 17/11", "## 17/11", "# toggl 17/11"]) {
    const result = parse(`${header}\n- [ ] 0800 a\n`);
    assert.equal(result.date, "2026-11-17", header);
    assert.equal(result.tag, header.includes("toggl") ? "toggl" : null, header);
  }
});
