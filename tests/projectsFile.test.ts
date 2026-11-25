import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TimeParseError } from "../src/core/errors";
import { matchesPrefix } from "../src/core/parser";
import { loadDatabase, Database } from "../src/core/reports";
import { addProject, BEGIN_MARK, END_MARK, loadDatabaseFile, scalar, Suggestion, syncSuggestions } from "../src/node/projectsFile";
import { existsSync } from "node:fs";

// A temporary folder for one test, removed afterwards.
function withDir(run: (dir: string, write: (text: string, name?: string) => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "tp-db-"));
  try {
    run(dir, (text, name = "projects.yml") => {
      const path = join(dir, name);
      writeFileSync(path, text, "utf-8");
      return path;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const suggestion = (text = "API review", minutes = 150, entries = 3): Suggestion => ({ text, minutes, entries });
const read = (path: string) => readFileSync(path, "utf-8");

function expectThrows(fn: () => unknown, pattern?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    if (pattern) assert.match((err as Error).message, pattern);
    return true;
  });
}

// ---- loading ------------------------------------------------------------------------

test("the dict form loads with a category and keywords", () => {
  withDir((_dir, write) => {
    const db: Database = loadDatabaseFile(write("gym:\n  category: personal\n  keywords: [gym, workout]\n"));

    assert.equal(db.get("gym")?.category, "personal");
    assert.deepEqual(db.get("gym")?.keywords, ["gym", "workout"]);
  });
});

test("the category is optional", () => {
  withDir((_dir, write) => {
    assert.equal(loadDatabaseFile(write("gym:\n  keywords: [gym]\n")).get("gym")?.category, null);
  });
});

test("the older list form still loads", () => {
  withDir((_dir, write) => {
    const db = loadDatabaseFile(write("lost: [lost]\n"));

    assert.deepEqual(db.get("lost")?.keywords, ["lost"]);
    assert.equal(db.get("lost")?.category, null);
  });
});

test("hierarchical names", () => {
  withDir((_dir, write) => {
    const db = loadDatabaseFile(write('"client-b:api-review":\n  category: professional\n  keywords: ["API review"]\n'));

    assert.equal(db.get("client-b:api-review")?.category, "professional");
    assert.deepEqual(db.get("client-b:api-review")?.keywords, ["API review"]);
  });
});

test("an invalid category is rejected", () => {
  expectThrows(() => loadDatabase("gym:\n  category: hobby\n  keywords: [gym]\n"), /personal or professional/);
});

test("an unknown field is rejected, so typos show", () => {
  expectThrows(() => loadDatabase("gym:\n  categroy: personal\n  keywords: [gym]\n"), /unknown field categroy/);
});

test("a keyword still belongs to one project", () => {
  expectThrows(() => loadDatabase("gym:\n  category: personal\n  keywords: [workout]\nfitness: [Workout]\n"), /maps to both/);
});

test("the error names the file", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  category: hobby\n  keywords: [gym]\n", "db.yml");

    expectThrows(() => loadDatabaseFile(path), /db\.yml/);
  });
});

test("an empty file is an empty database", () => {
  withDir((_dir, write) => {
    assert.equal(loadDatabaseFile(write("")).size, 0);
  });
});

test("the example database loads with categories", () => {
  const db = loadDatabaseFile(join(__dirname, "..", "tests", "fixtures", "sample", "projects.yml"));

  assert.equal(db.get("client-a")?.category, "professional");
  assert.equal(db.get("gym")?.category, "personal");
});

test("the prefix rule matches the name itself and its children only", () => {
  assert.equal(matchesPrefix("a:b", "a:b"), true);
  assert.equal(matchesPrefix("a:b:c", "a:b"), true);
  assert.equal(matchesPrefix("a:b:c:d", "a"), true);
  assert.equal(matchesPrefix("a:bc", "a:b"), false);
  assert.equal(matchesPrefix("a", "a:b"), false);
});

test("scalars are plain when safe and quoted when YAML would misread them", () => {
  assert.equal(scalar("x"), "x");
  assert.equal(scalar("API review"), "API review");
  assert.equal(scalar("123"), '"123"');
  assert.equal(scalar("yes"), '"yes"');
});

// ---- adding a project ----------------------------------------------------------------

const ORIGINAL = "# my projects\ngym:\n  category: personal\n  keywords: [gym]\n";

test("a project is appended with its name as keyword", () => {
  withDir((_dir, write) => {
    const path = write(ORIGINAL);

    const project = addProject(path, "lunch");

    assert.deepEqual(project.keywords, ["lunch"]);
    assert.equal(project.category, null);
    assert.deepEqual(loadDatabaseFile(path).get("lunch")?.keywords, ["lunch"]);
  });
});

test("the existing text is kept as it was", () => {
  withDir((_dir, write) => {
    const path = write(ORIGINAL);

    addProject(path, "lunch");

    assert.ok(read(path).startsWith(ORIGINAL));
  });
});

test("custom keywords", () => {
  withDir((_dir, write) => {
    const project = addProject(write(ORIGINAL), "client call", ["client-a call", "standup"]);

    assert.deepEqual(project.keywords, ["client-a call", "standup"]);
  });
});

test("names that YAML would misread are quoted", () => {
  withDir((_dir, write) => {
    const path = write("");

    addProject(path, "123");
    addProject(path, 'say "hi"');

    const db = loadDatabaseFile(path);
    assert.deepEqual(db.get("123")?.keywords, ["123"]);
    assert.deepEqual(db.get('say "hi"')?.keywords, ['say "hi"']);
  });
});

test("a clash is refused and the file is left alone", () => {
  withDir((_dir, write) => {
    const path = write(ORIGINAL);

    expectThrows(() => addProject(path, "GYM"), /gym/i);
    assert.equal(read(path), ORIGINAL);
  });
});

test("a name that is already a project is refused", () => {
  withDir((_dir, write) => {
    const path = write(ORIGINAL);

    expectThrows(() => addProject(path, "gym"));
    assert.equal(read(path), ORIGINAL);
  });
});

test("unknown is reserved", () => {
  withDir((_dir, write) => {
    expectThrows(() => addProject(write(ORIGINAL), "unknown"));
  });
});

test("an empty name is refused", () => {
  withDir((_dir, write) => {
    expectThrows(() => addProject(write(ORIGINAL), "   "), /must not be empty/);
  });
});

test("a missing database is refused", () => {
  withDir((dir) => {
    expectThrows(() => addProject(join(dir, "missing.yml"), "lunch"), /not found/);
  });
});

test("a project added after another is kept too", () => {
  withDir((_dir, write) => {
    const path = write("");

    addProject(path, "one");
    addProject(path, "two");

    assert.deepEqual([...loadDatabaseFile(path).keys()].sort(), ["one", "two"]);
  });
});

// ---- suggestions for unregistered projects --------------------------------------------

test("the block is appended as comments, and the rest of the file is kept", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");

    const count = syncSuggestions(path, [suggestion()]);
    const text = read(path);

    assert.equal(count, 1);
    assert.ok(text.startsWith("gym:\n  keywords: [gym]\n"));
    assert.ok(text.includes(BEGIN_MARK));
    assert.ok(text.includes("#API review:"));
    assert.ok(text.includes("#  keywords:\n#    - API review"));
    assert.ok(text.includes("# 2h 30m, 3 entries"));
    assert.ok(text.trimEnd().endsWith(END_MARK));
  });
});

test("the block is comments only, so the file still loads", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion()]);

    assert.deepEqual([...loadDatabaseFile(path).keys()], ["gym"]);
  });
});

test("accepting a suggestion by uncommenting makes it load", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion()]);
    const accepted = read(path)
      .split("\n")
      .map((line) => {
        const body = line.replace(/^#+/, "").trim();
        if (line.startsWith("#") && ["API review:", "keywords:", "- API review"].includes(body)) return line.replace("#", "");
        return line;
      });
    writeFileSync(path, accepted.join("\n") + "\n", "utf-8");

    assert.deepEqual(loadDatabaseFile(path).get("API review")?.keywords, ["API review"]);
  });
});

test("a resync adds new suggestions and keeps the old ones", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion("first")]);

    const added = syncSuggestions(path, [suggestion("first"), suggestion("second")]);
    const text = read(path);

    assert.equal(added, 1);
    assert.equal(text.split(BEGIN_MARK).length - 1, 1);
    assert.ok(text.includes("#first:"));
    assert.ok(text.includes("#second:"));
  });
});

test("no new suggestions leave the file alone", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion()]);
    const before = read(path);

    assert.equal(syncSuggestions(path, []), 0);
    assert.equal(read(path), before);
  });
});

test("edited lines inside the block are never overwritten", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion("API review")]);
    const edited = read(path).replace("#API review:", "client-b:api-review:").replace("#    - API review", "    - API review   # my note");
    writeFileSync(path, edited, "utf-8");

    const added = syncSuggestions(path, [suggestion("API review"), suggestion("Lunch")]);
    const text = read(path);

    assert.equal(added, 1);
    assert.ok(text.includes("client-b:api-review:"));
    assert.ok(text.includes("    - API review   # my note"));
    assert.ok(!text.includes("#API review:"));
    assert.ok(text.includes("#Lunch:"));
  });
});

test("a keyword already in the file is not suggested again", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\nfitness:\n  keywords:\n    - Lunch\n");

    assert.equal(syncSuggestions(path, [suggestion("lunch")]), 0);
    assert.ok(!read(path).includes(BEGIN_MARK));
  });
});

test("a name already in the file is not suggested again", () => {
  withDir((_dir, write) => {
    const path = write("#API review:\n#  keywords:\n#    - API review\n");

    assert.equal(syncSuggestions(path, [suggestion("API review")]), 0);
  });
});

test("nothing is removed from an existing block", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion("first")]);
    const before = read(path).split("\n").slice(0, -1); // drop the empty piece after the final newline

    syncSuggestions(path, []);
    syncSuggestions(path, [suggestion("first"), suggestion("second")]);

    const after = read(path).split("\n").slice(0, -1);
    // every earlier line is still there, in order; the new suggestion goes in before the end mark
    const kept = before.filter((line) => line !== END_MARK);
    assert.deepEqual(after.slice(0, kept.length), kept);
  });
});

test("a repeated sync is stable", () => {
  withDir((_dir, write) => {
    const path = write("gym:\n  keywords: [gym]\n");
    syncSuggestions(path, [suggestion()]);
    const first = read(path);

    syncSuggestions(path, [suggestion()]);

    assert.equal(read(path), first);
  });
});

test("names with quotes are quoted", () => {
  withDir((_dir, write) => {
    const path = write("");

    syncSuggestions(path, [suggestion('say "hi"')]);

    assert.ok(read(path).includes('#say "hi":'));
  });
});

test("a missing database is rejected", () => {
  withDir((dir) => {
    expectThrows(() => syncSuggestions(join(dir, "missing.yml"), [suggestion()]), /not found/);
    assert.ok(!existsSync(join(dir, "missing.yml")));
  });
});

test("an unterminated block is rejected and the file is untouched", () => {
  withDir((_dir, write) => {
    const text = `gym:\n  keywords: [gym]\n${BEGIN_MARK}\n# half a block\n`;
    const path = write(text);

    expectThrows(() => syncSuggestions(path, [suggestion()]), /never ends/);
    assert.equal(read(path), text);
  });
});

test("the error type for database problems is TimeParseError", () => {
  assert.throws(
    () => loadDatabase("gym: [workout]\nfitness: [Workout]\n"),
    (err: unknown) => err instanceof TimeParseError,
  );
});
