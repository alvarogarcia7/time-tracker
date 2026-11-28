// Command-line entry point. Each command calls the library functions directly; none of them goes
// through the editor's HTTP routes.
//
//   node dist/cli.js parse FILE [--projects DB] [--year N]
//   node dist/cli.js convert IN_DIR [OUT_DIR] [--pattern P]... [--projects DB] [--year N] [--force]
//   node dist/cli.js freeze [FILE] [--db DB] [--from D --to D --dir DATA_DIR] [--unfreeze]
//   node dist/cli.js reparse-check DATA_DIR --db DB
//   node dist/cli.js view FILE [--view all|entries|projects]
//   node dist/cli.js report DATA_DIR --db DB [--period P] [--from D] [--to D] [--project N]... [--prefix P]... [--category C] [--format text|json]
//   node dist/cli.js suggest DATA_DIR --db DB
//   node dist/cli.js editor FOLDER [--db DB] [--viewer DIR] [--backups DIR] [--host H] [--port N]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_PATTERNS, convertFolder } from "./node/batch";
import { dayFilesInRange, freezeFile, reparseCheck, snapshotsDirFor } from "./node/freeze";
import { createEditorServer, Workspace } from "./node/editorServer";
import { loadDatabaseFile, syncSuggestions } from "./node/projectsFile";
import { parseDay } from "./core/parser";
import { PERIODS, buildReport, checkSelection, LoadedDay, recordsFromFiles, unregisteredSuggestions, keywordsOf } from "./core/reports";
import { CATEGORIES } from "./core/reports";
import { renderDocument, renderReport, VIEWS, View } from "./core/textView";
import { validate } from "./core/summary";


class UsageError extends Error {}

const USAGE = `usage: node dist/cli.js <command> [arguments]

  parse FILE [--projects DB] [--year N]          parse one day file (or stdin) to JSON
  convert IN_DIR [OUT_DIR] [--pattern P]... [--projects DB] [--year N] [--force]
                                                 convert every day file in a folder to JSON
  freeze [FILE] [--db DB] [--from D --to D --dir DATA_DIR] [--unfreeze]
                                                 freeze a day file, or every day in a date range
  reparse-check DATA_DIR --db DB                 parse the frozen files again and list what changed
  view FILE [--view all|entries|projects]        show a parser output file as text
  report DATA_DIR --db DB [options]              hours by period and by project
  suggest DATA_DIR --db DB                       add unregistered projects to the database
  editor FOLDER [--db DB] [--port N]             web editor for the day files`;

const splitList = (values: string[] | undefined): string[] =>
  (values ?? []).flatMap((value) => value.split(",")).map((part) => part.trim()).filter(Boolean);

function jsonFiles(dataDir: string): LoadedDay[] {
  if (!statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dataDir}: not a folder`);
  return readdirSync(dataDir)
    .filter((name) => name.endsWith(".json") && statSync(join(dataDir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dataDir, name), "utf-8") }));
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

function command(name: string, args: string[]): number {
  switch (name) {
    case "parse": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { projects: { type: "string" }, year: { type: "string" }, indent: { type: "string" } },
      });
      const file = positionals[0];
      const text = file && file !== "-" ? readFileSync(file, "utf-8") : readFileSync(0, "utf-8");
      const projects = values.projects ? Object.fromEntries(keywordsOf(loadDatabaseFile(values.projects))) : undefined;
      const day = parseDay(text, {
        projects,
        defaultYear: values.year ? Number(values.year) : undefined,
      });
      process.stdout.write(JSON.stringify(day, null, Number(values.indent ?? 2)) + "\n");
      return 0;
    }
    case "convert": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          pattern: { type: "string", multiple: true },
          projects: { type: "string" },
          year: { type: "string" },
          force: { type: "boolean" },
        },
      });
      const inDir = positionals[0];
      if (!inDir) throw new UsageError("convert needs IN_DIR");
      const outDir = positionals[1] ?? inDir;
      const projects = values.projects ? Object.fromEntries(keywordsOf(loadDatabaseFile(values.projects))) : undefined;
      const result = convertFolder(inDir, outDir, {
        patterns: values.pattern?.length ? values.pattern : DEFAULT_PATTERNS,
        projects,
        projectsText: values.projects && existsSync(values.projects) ? readFileSync(values.projects, "utf-8") : undefined,
        snapshotsDir: values.projects ? snapshotsDirFor(values.projects) : undefined,
        defaultYear: values.year ? Number(values.year) : undefined,
        force: values.force ?? false,
      });
      for (const failure of result.failed) process.stderr.write(`error: ${failure.file} - ${failure.message}\n`);
      process.stdout.write(
        `Converted ${result.written.length} file(s) into ${outDir}; ${result.skipped.length} unchanged and skipped; ${result.failed.length} failed\n`,
      );
      return result.failed.length ? 1 : 0;
    }
    case "view": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { view: { type: "string", default: "all" } },
      });
      const file = positionals[0];
      if (!file) throw new UsageError("view needs FILE");
      if (!(VIEWS as readonly string[]).includes(values.view ?? "all")) throw new UsageError(`unknown view '${values.view}'`);
      const doc = validate(JSON.parse(readFileSync(file, "utf-8")));
      process.stdout.write(renderDocument(doc, values.view as View) + "\n");
      return 0;
    }
    case "report": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          db: { type: "string" },
          period: { type: "string", default: "monthly" },
          from: { type: "string" },
          to: { type: "string" },
          project: { type: "string", multiple: true },
          prefix: { type: "string", multiple: true },
          category: { type: "string" },
          format: { type: "string", default: "text" },
        },
      });
      const dataDir = positionals[0];
      if (!dataDir) throw new UsageError("report needs DATA_DIR");
      const db = loadDatabaseFile(requireOption(values.db, "db"));
      const { records, skipped } = recordsFromFiles(jsonFiles(dataDir), db);
      const names = splitList(values.project);
      const prefixes = splitList(values.prefix);
      const category = values.category as (typeof CATEGORIES)[number] | undefined;
      if (!(PERIODS as readonly string[]).includes(values.period ?? "monthly")) throw new UsageError(`unknown period '${values.period}'`);
      checkSelection(db, names, prefixes, category);
      const report = buildReport(records, values.period as (typeof PERIODS)[number], {
        start: values.from,
        end: values.to,
        names,
        prefixes,
        category,
      }, skipped);
      process.stdout.write(
        (values.format === "json" ? JSON.stringify(report, null, 2) : renderReport(report)) + "\n",
      );
      return 0;
    }
    case "suggest": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { db: { type: "string" } },
      });
      const dataDir = positionals[0];
      if (!dataDir) throw new UsageError("suggest needs DATA_DIR");
      const dbPath = requireOption(values.db, "db");
      const db = loadDatabaseFile(dbPath);
      const { records } = recordsFromFiles(jsonFiles(dataDir), db);
      const count = syncSuggestions(dbPath, unregisteredSuggestions(records, db));
      process.stdout.write(`Wrote ${count} unregistered project(s) to ${dbPath}\n`);
      return 0;
    }
    case "freeze": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          db: { type: "string", default: "data/projects.yml" },
          from: { type: "string" },
          to: { type: "string" },
          dir: { type: "string" },
          unfreeze: { type: "boolean" },
        },
      });
      const file = positionals[0];
      const db = values.db ?? "data/projects.yml";
      const outcomes: string[] = [];
      let failed = 0;
      const files: string[] = [];
      if (file) files.push(file);
      if (values.from || values.to) {
        if (!values.from || !values.to || !values.dir) throw new UsageError("a range needs --from, --to and --dir");
        for (const day of dayFilesInRange(values.dir, values.from, values.to)) {
          if (day.error) {
            failed += 1;
            process.stderr.write(`error: ${day.file} - ${day.error}\n`);
          } else files.push(day.file);
        }
      }
      if (!files.length && !failed) throw new UsageError("freeze needs FILE, or --from, --to and --dir");
      for (const path of files) {
        try {
          const done = freezeFile(path, { projectsPath: db, unfreeze: values.unfreeze ?? false });
          if (values.unfreeze) outcomes.push(`${path}: ${done.changed ? "unfrozen" : "not frozen"}`);
          else
            outcomes.push(
              `${path}: ${done.changed ? "frozen" : "already frozen"} with ${done.snapshot}${done.snapshotCreated ? " (new snapshot)" : ""}`,
            );
        } catch (err) {
          failed += 1;
          process.stderr.write(`error: ${path} - ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      for (const line of outcomes) process.stdout.write(line + "\n");
      process.stdout.write(`${outcomes.length} file(s); ${failed} failed\n`);
      return failed ? 1 : 0;
    }
    case "reparse-check": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { db: { type: "string" } },
      });
      const dataDir = positionals[0];
      if (!dataDir) throw new UsageError("reparse-check needs DATA_DIR");
      const entries = reparseCheck(dataDir, requireOption(values.db, "db"));
      for (const entry of entries) {
        process.stdout.write(`${entry.file}: ${entry.status}\n`);
        for (const line of entry.lines) process.stdout.write(`  ${line}\n`);
      }
      const bad = entries.filter((entry) => entry.status !== "same").length;
      process.stdout.write(`${entries.length} frozen file(s) checked; ${bad} with a difference or an error\n`);
      return bad ? 1 : 0;
    }
    case "editor": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          db: { type: "string" },
          viewer: { type: "string", default: "viewer" },
          backups: { type: "string", default: "build/editor-backups" },
          host: { type: "string", default: "127.0.0.1" },
          port: { type: "string", default: "8001" },
        },
      });
      const folder = positionals[0];
      if (!folder) throw new UsageError("editor needs FOLDER");
      const workspace = new Workspace(resolve(folder), values.db, values.backups ?? "build/editor-backups");
      const server = createEditorServer(workspace, values.viewer ?? "viewer");
      const host = values.host ?? "127.0.0.1";
      server.listen(Number(values.port ?? 8001), host, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : values.port;
        process.stdout.write(`Editing ${folder} at http://${host}:${port}/ (Ctrl-C to stop)\n`);
      });
      return 0; // the server keeps the process alive
    }
    default:
      throw new UsageError(`unknown command '${name}'`);
  }
}

export function main(argv: string[]): number {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE + "\n");
    return name ? 0 : 1;
  }
  try {
    return command(name, rest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}
