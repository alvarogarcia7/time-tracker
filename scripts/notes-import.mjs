#!/usr/bin/env node
// Bulk import of the Toggl notes exported by Notes Exporter.
//
//   node scripts/notes-import.mjs select --root EXPORT_ROOT --out IMPORT_DIR
//       Picks the notes whose file name (or title) contains "toggl", copies their
//       Markdown files into IMPORT_DIR, writes selection.json with the checks, and
//       writes delete.sh, which removes the original files once the import is accepted.
//   node scripts/notes-import.mjs review --out IMPORT_DIR
//       After the Markdown files were converted (make import), prints the files to
//       review and the files to categorize, and writes REPORT.md.
//
// Only Node built-ins are used. Reads the exporter's tracking files (EXPORT_ROOT/data/*.json)
// and Markdown (EXPORT_ROOT/md/<subdir>/<filename>.md); writes nothing into the export.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
      if (rec && !rec.deletedAt) records.push({ noteNo, ...rec });
    }
  }
  return records;
}

function isToggl(rec) {
  return /toggl/i.test(rec.filename ?? "") || /toggl/i.test(rec.title ?? "");
}

function select() {
  const root = values.root ?? process.env.NOTES_EXPORT_ROOT_DIR ?? join(homedir(), "Downloads", "AppleNotesExport");
  const out = values.out;
  if (!out) fail("select needs --out IMPORT_DIR");
  mkdirSync(out, { recursive: true });

  const notes = [];
  for (const rec of trackerRecords(root).filter(isToggl).sort((a, b) => a.noteNo.localeCompare(b.noteNo, undefined, { numeric: true }))) {
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
    if (!existsSync(source)) {
      problems.push(`no Markdown file at md/${rec.subdir ?? ""}/${file}`);
    } else {
      const header = firstNonEmptyLine(readFileSync(source, "utf8"));
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
      const prepared = withParsableHeader(readFileSync(source, "utf8"), date, dateFrom);
      writeFileSync(join(out, file), prepared.text);
      notice = prepared.notice;
    }

    notes.push({
      noteNo: rec.noteNo,
      title: rec.title ?? "",
      filename: rec.filename,
      file,
      source: existsSync(source) ? source : null,
      related,
      createdAt: rec.createdAt ?? null,
      date: date ? `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}` : null,
      dateFrom,
      problems,
      notice,
    });
  }

  const selection = { root, selectedAt: new Date().toISOString(), notes };
  writeFileSync(join(out, "selection.json"), JSON.stringify(selection, null, 2) + "\n");

  // delete.sh removes the originals of the copied notes: the Markdown file, and the same note in raw/ and html/. It is written now but nothing is removed
  // until someone runs it, after the import has been reviewed and accepted.
  const originals = notes.flatMap((n) => [n.source, ...(n.related ?? [])]).filter(Boolean);
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
  const latest = join(dirname(out), "latest");
  if (existsSync(latest) && !lstatSync(latest).isSymbolicLink()) {
    console.log(`Not updating ${latest}: it is a folder, not a link`);
  } else {
    if (existsSync(latest) || lstatSync(latest, { throwIfNoEntry: false })) unlinkSync(latest);
    symlinkSync(basename(out), latest);
  }

  const copied = notes.filter((n) => existsSync(join(out, n.file))).length;
  console.log(`Selected ${notes.length} Toggl notes, copied ${copied} Markdown files to ${out}`);
  console.log(`Wrote ${join(out, "delete.sh")}; run it only after the import is accepted`);
}

function review() {
  const out = values.out;
  if (!out) fail("review needs --out IMPORT_DIR");
  const selectionPath = join(out, "selection.json");
  if (!existsSync(selectionPath)) fail(`no selection.json in ${out}; run select first`);
  const { notes } = JSON.parse(readFileSync(selectionPath, "utf8"));

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
else fail("usage: notes-import.mjs select|review --out DIR [--root DIR]");
