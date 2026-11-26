#!/usr/bin/env node
// Bulk import of the Toggl notes exported by Notes Exporter.
//
//   node scripts/notes-import.mjs select --root EXPORT_ROOT --out IMPORT_DIR
//                                        [--exclude FOLDER]... [--include FOLDER]...
//       Picks the notes whose file name (or title) contains "toggl", copies their
//       Markdown files into IMPORT_DIR, writes selection.json with the checks, and
//       writes delete.sh, which removes the original files once the import is accepted.
//       Every folder is selected except those excluded: iCloud-Recently-Deleted by default, and the
//       folders named with --exclude. --include takes a folder back (for example a folder inside an
//       excluded one). A folder name also covers its subfolders.
//   node scripts/notes-import.mjs review --out IMPORT_DIR
//       After the Markdown files were converted (make import), prints the files to
//       review and the files to categorize, and writes REPORT.md.
//
// Only Node built-ins are used. Reads the exporter's tracking files (EXPORT_ROOT/data/*.json)
// and Markdown (EXPORT_ROOT/md/<subdir>/<filename>.md); writes nothing into the export.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// A date in the first line: "6/5", "6-5", "6.5", optionally with a year. Lenient on purpose.
const HEADER_DATE = /(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*[\/.\-]\s*(\d{2,4}))?/;

// The first line the parser reads as a day header (the same pattern as src/core/header.ts).
const PARSER_HEADER = /^(?:#+\s*)?(?:(\w+)\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s.*)?$/;

// Makes the first line a header the parser reads. A line that is only "#" is replaced; any other
// first line gets the header put above it. The date is the one found in the note, or the creation date.
function withParsableHeader(text, date, dateFrom) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index !== -1 && PARSER_HEADER.test(lines[index].trim())) return { text, notice: null };
  if (!date) return { text, notice: null }; // no date at all: the review already lists this note

  const header = `#toggl ${date.d}/${date.m}/${date.y}`;
  const shown = index === -1 ? "empty" : `"${lines[index].trim()}"`;
  if (index !== -1 && /^\s*#+\s*$/.test(lines[index])) {
    lines[index] = header;
  } else {
    lines.splice(index === -1 ? 0 : index, 0, header);
  }
  const notice = dateFrom === "createdAt"
    ? `the first line was ${shown}, so the date ${pretty(date)} was taken from the creation date`
    : `the date in the first line was written as the header ${header}`;
  return { text: lines.join("\n"), notice };
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    out: { type: "string" },
    file: { type: "string" },
    ledger: { type: "string" },
    include: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
  },
});
const [command] = positionals;

// A string the shell reads as one word, whatever characters it has.
function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fail(message) {
  console.error(`notes-import: ${message}`);
  process.exit(1);
}

// Local calendar date of an ISO string with offset, e.g. "2026-05-06T20:51:33+04:00" -> {y:2026, m:5, d:6}.
function localDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

function pretty({ y, m, d }) {
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function firstNonEmptyLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}

function trackerRecords(root) {
  const dataDir = join(root, "data");
  if (!existsSync(dataDir)) fail(`no data folder in ${root}`);
  const records = [];
  for (const name of readdirSync(dataDir).sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const tracker = JSON.parse(readFileSync(join(dataDir, name), "utf8"));
    for (const [noteNo, rec] of Object.entries(tracker)) {
      if (rec && !rec.deletedAt) records.push({ noteNo, tracker: name, ...rec });
    }
  }
  return records;
}

function isToggl(rec) {
  return /toggl/i.test(rec.filename ?? "") || /toggl/i.test(rec.title ?? "");
}

// Folders left out unless --include names them. Notes Exporter's Recently Deleted holds the notes deleted in iCloud.
const DEFAULT_EXCLUDED_FOLDERS = ["iCloud-Recently-Deleted"];

// The folder rules, in the order they were given: the defaults, then --exclude, then --include, so an
// --include of the same folder as an exclude wins. A rule names a folder and its subfolders.
function folderRules(includes, excludes) {
  const named = (list, include, origin) => list.map((text) => {
    const pattern = text.trim().replace(/^\/+|\/+$/g, "");
    if (!pattern) fail(`${origin} needs a folder name`);
    return { pattern, include, origin };
  });
  return [
    ...named(DEFAULT_EXCLUDED_FOLDERS, false, "default"),
    ...named(excludes, false, "--exclude"),
    ...named(includes, true, "--include"),
  ];
}

// The rule that decides a note with these folder names: the most specific matching rule (the one with the
// most folder levels), and with equal depth the later rule. A note no rule matches is selected.
function decideFolder(names, rules) {
  let best = null;
  for (const rule of rules) {
    const matches = names.some((name) => name === rule.pattern || name.startsWith(`${rule.pattern}/`));
    if (!matches) continue;
    const depth = rule.pattern.split("/").length;
    if (best === null || depth >= best.depth) best = { ...rule, depth };
  }
  if (best !== null) return best;
  return { pattern: null, include: true, origin: null };
}

// The folder names a note is filed under: its output subdirectory, and its folder path (Work/Projects).
function folderNames(rec) {
  const names = [rec.subdir ?? ""];
  if (Array.isArray(rec.folderPath) && rec.folderPath.length) names.push(rec.folderPath.join("/"));
  return names.filter((name) => name !== "");
}

// The ledger: one entry per imported Apple Notes note, with the copy the import wrote. See docs/notes-import.md.
const LEDGER_NAME = "imports.json";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// The Notes id of the note. Records from before Notes Exporter 1.3.0 that never exported again have none.
const noteKey = (rec) => rec.id ?? `legacy:${rec.tracker}/${rec.noteNo}`;

function readLedger(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, notes: {} };
}

function writeLedger(path, ledger) {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
}

function isoDay(date) {
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

function select() {
  const root = values.root ?? process.env.NOTES_EXPORT_ROOT_DIR ?? join(homedir(), "Downloads", "AppleNotesExport");
  const out = values.out;
  if (!out) fail("select needs --out IMPORT_DIR");
  mkdirSync(out, { recursive: true });

  // The import folders live in data/in; the ledger is kept there too, so it outlives each folder.
  const importRoot = dirname(out);
  const folderName = basename(out);
  const ledgerPath = join(importRoot, LEDGER_NAME);
  const ledger = readLedger(ledgerPath);

  const rules = folderRules(values.include ?? [], values.exclude ?? []);
  const notes = []; // copied into this folder (new or updated), or Markdown missing
  const unchanged = []; // imported before, and not changed in Apple Notes since
  const conflicts = []; // changed in Apple Notes, and the local copy was edited: nothing copied
  const skipped = [];
  for (const rec of trackerRecords(root).filter(isToggl).sort((a, b) => a.noteNo.localeCompare(b.noteNo, undefined, { numeric: true }))) {
    const decision = decideFolder(folderNames(rec), rules);
    if (!decision.include) {
      skipped.push({ noteNo: rec.noteNo, title: rec.title ?? "", folder: rec.subdir ?? "", rule: decision.pattern });
      continue;
    }
    const problems = [];
    const created = localDate(rec.createdAt);
    const file = `${rec.filename}.md`;
    const source = join(root, "md", rec.subdir ?? "", file);
    // The same note in the other export folders: raw/ and html/ hold it as .html (only when they exist).
    const related = ["raw", "html"]
      .map((dir) => join(root, dir, rec.subdir ?? "", `${rec.filename}.html`))
      .filter((path) => existsSync(path));

    let date = created;
    let dateFrom = "createdAt";
    let notice = null;
    let prepared = null;
    const sourceData = existsSync(source) ? readFileSync(source) : null;
    if (sourceData === null) {
      problems.push(`no Markdown file at md/${rec.subdir ?? ""}/${file}`);
    } else {
      const text = sourceData.toString("utf8");
      const header = firstNonEmptyLine(text);
      const found = HEADER_DATE.exec(header);
      if (found) {
        const day = Number(found[1]);
        const month = Number(found[2]);
        const year = found[3] ? (found[3].length === 2 ? 2000 + Number(found[3]) : Number(found[3])) : created?.y;
        date = { y: year, m: month, d: day };
        dateFrom = "first line";
        if (!created) {
          problems.push("the creation date is missing, so the first-line date could not be checked");
        } else if (day !== created.d || month !== created.m || (found[3] && year !== created.y)) {
          problems.push(`the first line says ${pretty(date)}, but the note was created on ${pretty(created)}`);
        }
      } else if (!created) {
        problems.push("no date in the first line and no creation date");
      }
      prepared = withParsableHeader(text, date, dateFrom);
      notice = prepared.notice;
    }

    const note = {
      noteNo: rec.noteNo,
      title: rec.title ?? "",
      filename: rec.filename,
      file,
      source: sourceData === null ? null : source,
      related,
      createdAt: rec.createdAt ?? null,
      folder: rec.subdir ?? "",
      date: date ? isoDay(date) : null,
      dateFrom,
      problems,
      notice,
    };
    if (prepared === null) {
      notes.push({ ...note, status: "missing" });
      continue;
    }

    // Decide from the ledger: is there a copy, has Apple Notes changed, and has the copy been edited?
    const key = noteKey(rec);
    const entry = ledger.notes[key];
    const localPath = entry ? join(importRoot, entry.file) : null;
    const sourceHash = sha256(sourceData);
    let status = "new";
    if (entry && existsSync(localPath)) {
      if (entry.sourceHash === sourceHash) status = "unchanged";
      else if (sha256(readFileSync(localPath)) === entry.importedHash) status = "updated";
      else status = "conflict";
    }

    if (status === "unchanged") {
      delete entry.pending;
      unchanged.push({ noteNo: rec.noteNo, title: note.title, source: note.source, related });
      continue;
    }
    if (status === "conflict") {
      mkdirSync(join(out, "incoming"), { recursive: true });
      writeFileSync(join(out, "incoming", file), prepared.text);
      entry.pending = { sourceHash, incoming: `${folderName}/incoming/${file}` };
      conflicts.push({
        noteNo: rec.noteNo,
        title: note.title,
        local: entry.file,
        incoming: entry.pending.incoming,
        folder: note.folder,
        source: note.source,
        related,
      });
      continue;
    }

    writeFileSync(join(out, file), prepared.text);
    ledger.notes[key] = {
      title: note.title,
      appleFolder: note.folder,
      file: `${folderName}/${file}`,
      importedHash: sha256(Buffer.from(prepared.text, "utf8")),
      sourceHash,
      importedAt: new Date().toISOString(),
    };
    notes.push({ ...note, status, replaces: status === "updated" ? entry.file : null });
  }
  writeLedger(ledgerPath, ledger);

  const selection = {
    root,
    selectedAt: new Date().toISOString(),
    ledger: ledgerPath,
    folderRules: rules.map(({ pattern, include, origin }) => ({ folder: pattern, action: include ? "include" : "exclude", origin })),
    notes,
    unchanged,
    conflicts,
    skipped,
  };
  writeFileSync(join(out, "selection.json"), JSON.stringify(selection, null, 2) + "\n");

  // delete.sh removes the originals of the notes whose content is in this folder or already imported: the
  // Markdown file, and the same note in raw/ and html/. A conflict is left alone: Apple Notes has a version
  // that is not imported yet. Nothing is removed until someone runs it, after the import has been reviewed.
  const imported = [...notes.filter((n) => n.status === "new" || n.status === "updated"), ...unchanged];
  const originals = imported.flatMap((n) => [n.source, ...(n.related ?? [])]).filter(Boolean);
  const script = [
    "#!/usr/bin/env bash",
    "# Deletes the original Notes Exporter files of the Toggl notes imported into this folder.",
    "# Run it only when the import is accepted: the files are deleted, not moved.",
    "set -euo pipefail",
    "",
    ...originals.map((path) => `rm -v -- ${shellQuote(path)}`),
    `echo "Deleted ${originals.length} original file(s)."`,
    "",
  ].join("\n");
  writeFileSync(join(out, "delete.sh"), script, { mode: 0o755 });

  // data/in/latest points at the newest selection, so the later steps need not know its name.
  const latest = join(importRoot, "latest");
  if (existsSync(latest) && !lstatSync(latest).isSymbolicLink()) {
    console.log(`Not updating ${latest}: it is a folder, not a link`);
  } else {
    if (existsSync(latest) || lstatSync(latest, { throwIfNoEntry: false })) unlinkSync(latest);
    symlinkSync(folderName, latest);
  }

  const count = (status) => notes.filter((n) => n.status === status).length;
  const copied = notes.filter((n) => existsSync(join(out, n.file))).length;
  console.log(
    `Selected ${notes.length + unchanged.length + conflicts.length} Toggl notes: ${count("new")} new, ${count("updated")} updated, ` +
      `${unchanged.length} unchanged, ${conflicts.length} changed in Apple Notes but edited here; copied ${copied} Markdown files to ${out}`,
  );
  if (conflicts.length) console.log(`Kept ${conflicts.length} local edits; see REPORT.txt for how to decide each one`);
  if (skipped.length) {
    const byFolder = new Map();
    for (const note of skipped) byFolder.set(note.folder, (byFolder.get(note.folder) ?? 0) + 1);
    const list = [...byFolder].map(([folder, count]) => `${folder || "(no folder)"} (${count})`).join(", ");
    console.log(`Left out ${skipped.length} Toggl notes in excluded folders: ${list}`);
  }
  console.log(`Wrote ${join(out, "delete.sh")}; run it only after the import is accepted`);
}

// keep-local and take-incoming: decide a conflict. --file is the local copy, as the report names it.
function decideConflict(mode) {
  const ledgerPath = values.ledger ?? join("data", "in", LEDGER_NAME);
  if (!values.file) fail(`${command} needs --file LOCAL_COPY`);
  const importRoot = dirname(resolve(ledgerPath));
  const ledger = readLedger(ledgerPath);
  const target = resolve(values.file);
  const key = Object.keys(ledger.notes).find((item) => resolve(importRoot, ledger.notes[item].file) === target);
  if (!key) fail(`${values.file} is not an imported copy in ${ledgerPath}`);
  const entry = ledger.notes[key];
  if (!entry.pending) fail(`${values.file} has no changed Apple Notes version waiting: nothing to decide`);

  const incoming = resolve(importRoot, entry.pending.incoming);
  if (mode === "take-incoming") {
    // The edited copy is kept beside the day, where make import does not read it.
    const replaced = join(dirname(target), "replaced");
    mkdirSync(replaced, { recursive: true });
    copyFileSync(target, join(replaced, basename(target)));
    copyFileSync(incoming, target);
    entry.importedHash = sha256(readFileSync(target));
    console.log(`Replaced ${values.file} with the Apple Notes version; the edited copy is in ${join(replaced, basename(target))}`);
  } else {
    console.log(`Kept ${values.file}; the Apple Notes version is accepted as seen`);
  }
  entry.sourceHash = entry.pending.sourceHash;
  delete entry.pending;
  if (existsSync(incoming)) unlinkSync(incoming);
  writeLedger(ledgerPath, ledger);
  console.log(`Run make import IMPORT_DIR=${dirname(target)} to regenerate its JSON`);
}

function review() {
  const out = values.out;
  if (!out) fail("review needs --out IMPORT_DIR");
  const selectionPath = join(out, "selection.json");
  if (!existsSync(selectionPath)) fail(`no selection.json in ${out}; run select first`);
  const { notes, conflicts = [] } = JSON.parse(readFileSync(selectionPath, "utf8"));
  const importRoot = dirname(out);

  const toReview = [];
  const toCategorize = [];
  for (const note of notes) {
    const reasons = [...note.problems];
    const jsonPath = join(out, `${basename(note.file, ".md")}.json`);
    if (existsSync(join(out, note.file)) && !existsSync(jsonPath)) {
      reasons.push("the file could not be converted (see the import output above)");
    }
    if (reasons.length) toReview.push({ ...note, reasons });

    if (existsSync(jsonPath)) {
      const day = JSON.parse(readFileSync(jsonPath, "utf8"));
      const unassigned = (day.entries ?? []).filter((e) => !e.project || e.project === "unknown");
      if (unassigned.length) toCategorize.push({ ...note, lines: unassigned });
    }
  }

  const lines = [];
  lines.push(`Import of ${notes.length} Toggl notes (${selectionPath.replace(/selection\.json$/, "")})`);
  lines.push("");
  lines.push(`Files to review (${toReview.length})`);
  lines.push("These need a look before they can be trusted: the date in the first line does not match the creation date, or the file could not be read.");
  if (toReview.length === 0) lines.push("  None. Every file's date checks out.");
  for (const n of toReview) {
    lines.push(`  - ${n.title || n.filename} (${join(out, n.file)})`);
    for (const r of n.reasons) lines.push(`      ${r}`);
  }
  lines.push("");
  lines.push("");
  lines.push(`Changed in Apple Notes, local copy kept (${conflicts.length})`);
  lines.push("The note changed in Apple Notes after it was imported, and its local copy was edited. Nothing was overwritten.");
  if (conflicts.length === 0) lines.push("  None.");
  for (const c of conflicts) {
    const local = join(importRoot, c.local);
    lines.push(`  - ${c.title || c.noteNo} (${local})`);
    lines.push(`      Apple Notes version: ${join(importRoot, c.incoming)}`);
    lines.push(`      keep your edits:  make notes-keep-local FILE=${local}`);
    lines.push(`      take Apple Notes: make notes-take-incoming FILE=${local}`);
  }
  const updated = notes.filter((n) => n.status === "updated");
  lines.push("");
  lines.push(`Updated from Apple Notes (${updated.length})`);
  lines.push("The note changed in Apple Notes and the local copy was not edited, so the new version was imported. The older copy is superseded.");
  if (updated.length === 0) lines.push("  None.");
  for (const n of updated) lines.push(`  - ${n.title || n.filename} (${join(out, n.file)}), replaces ${join(importRoot, n.replaces)}`);
  lines.push("");
  const notices = notes.filter((n) => n.notice);
  lines.push(`Notices (${notices.length})`);
  lines.push("Not errors: the note was imported with the date shown.");
  if (notices.length === 0) lines.push("  None.");
  for (const n of notices) lines.push(`  - ${n.title || n.filename} (${join(out, n.file)}): ${n.notice}`);
  lines.push("");
  lines.push(`Files to categorize (${toCategorize.length})`);
  lines.push("These have entries with no project yet. Give each one a project (add a keyword in data/projects.yml or use make editor), then run make import again.");
  if (toCategorize.length === 0) lines.push("  None. Every entry has a project.");
  for (const n of toCategorize) {
    lines.push(`  - ${n.title || n.filename} (${join(out, n.file)})`);
    for (const e of n.lines) lines.push(`      line ${e.line}: ${e.description || "(no description)"}`);
  }

  const text = lines.join("\n") + "\n";
  // .txt, not .md: make import converts every .md in the folder.
  writeFileSync(join(out, "REPORT.txt"), text);
  console.log(text);
}

if (command === "select") select();
else if (command === "review") review();
else if (command === "keep-local") decideConflict("keep-local");
else if (command === "take-incoming") decideConflict("take-incoming");
else fail("usage: notes-import.mjs select --out DIR | review --out DIR | keep-local --file COPY | take-incoming --file COPY");
