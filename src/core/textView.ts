// Text output: tables for the terminal, for the day viewer and for the reports.
import type { Report } from "./reports";
import { Entry, TimeEntryDay, formatMinutes, groupByProject, totals } from "./summary";

export const VIEWS = ["all", "entries", "projects"] as const;
export type View = (typeof VIEWS)[number];

// Columns padded to the widest cell; trailing spaces removed.
export function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) => Math.max(...all.map((row) => (row[column] ?? "").length)));
  return all
    .map((row) => row.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd())
    .join("\n");
}

function describeNote(entry: Entry): string {
  const notes: string[] = [];
  if (entry.reference) notes.push(`same as ${entry.reference.start} (line ${entry.reference.line})`);
  if (entry.start_type === "relative") notes.push(`relative: ${entry.time_expression}`);
  return notes.join("; ");
}

function entryRows(entries: Entry[]): string[][] {
  return entries.map((entry) => {
    let description = entry.description || "(no description)";
    const note = describeNote(entry);
    if (note) description = `${description}  [${note}]`;
    return [
      String(entry.line),
      entry.start,
      entry.end ?? "-",
      formatMinutes(entry.duration_minutes),
      entry.project,
      description,
    ];
  });
}

export function renderEntries(entries: Entry[]): string {
  return renderTable(["Line", "Start", "End", "Duration", "Project", "Description"], entryRows(entries));
}

export function renderProjects(entries: Entry[]): string {
  return groupByProject(entries)
    .map((group) => {
      const count = `${group.count} ${group.count === 1 ? "entry" : "entries"}`;
      let summary = `${formatMinutes(group.minutes)}, ${count}`;
      if (group.open) summary += `, ${group.open} open`;
      const rows = entryRows(group.entries).map((row) => [row[0], row[1], row[2], row[3], row[5]]);
      const table = renderTable(["Line", "Start", "End", "Duration", "Description"], rows);
      return `${group.project}  (${summary})\n${table}`;
    })
    .join("\n\n");
}

export function renderDocument(doc: TimeEntryDay, view: View = "all"): string {
  if (!(VIEWS as readonly string[]).includes(view)) {
    throw new Error(`unknown view '${view}'; expected one of ${VIEWS.join(", ")}`);
  }
  const entries = doc.entries;
  const meta = [
    `Date: ${doc.date ?? "?"}`,
    doc.tag ? `Tag: #${doc.tag}` : null,
    doc.parsed_at ? `Parsed: ${doc.parsed_at}` : null,
    doc.parser_version ? `Parser: ${doc.parser_version}` : null,
  ].filter((item): item is string => item !== null);
  const all = totals(entries);
  let summary = `${all.count} entries, ${formatMinutes(all.minutes)} tracked`;
  if (all.open) summary += `, ${all.open} open`;

  const parts = [meta.join("  "), summary];
  if (view === "all" || view === "entries") {
    parts.push(`Time entries\n${entries.length ? renderEntries(entries) : "(none)"}`);
  }
  if (view === "all" || view === "projects") {
    parts.push(`By project\n${entries.length ? renderProjects(entries) : "(none)"}`);
  }
  return parts.join("\n\n");
}

export function renderReport(report: Report): string {
  const totalsRow = report.totals;
  const span = report.from ? `${report.from} to ${report.to}` : "no entries";
  const scope: string[] = [];
  if (report.projects.length) scope.push(`projects ${report.projects.join(", ")}`);
  if (report.prefixes.length) scope.push(`prefix ${report.prefixes.join(", ")}`);
  if (report.category) scope.push(`category ${report.category}`);
  const lines = [
    `Report: ${report.period}, ${span}`,
    `Scope: ${scope.length ? scope.join("; ") : "all projects"}`,
    `Total: ${totalsRow.hours.toFixed(2)} h, ${totalsRow.entries} entries, ${totalsRow.open_entries} open (not counted), ${totalsRow.days} days`,
    "",
    "Hours per period",
    renderTable(
      ["Period", "Hours", "Entries", "Open"],
      report.by_period.map((row) => [row.period, row.hours.toFixed(2), String(row.entries), String(row.open_entries)]),
    ),
    "",
    "Hours per project",
    renderTable(
      ["Project", "Category", "Hours", "Share", "Entries", "Open"],
      report.by_project.map((row) => [
        row.project,
        row.category ?? "uncategorised",
        row.hours.toFixed(2),
        `${row.share_percent.toFixed(1)}%`,
        String(row.entries),
        String(row.open_entries),
      ]),
    ),
  ];
  if (report.skipped.length) lines.push("", "Skipped files:", ...report.skipped.map((item) => `  ${item}`));
  return lines.join("\n");
}

