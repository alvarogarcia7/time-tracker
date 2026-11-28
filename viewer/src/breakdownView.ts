// The project and task breakdown table: each project with its sub-projects and tasks under it, and a total
// row. Shared by the week viewer and the reports, so both show the same rows (the rows come from breakdownRows).
import { TaskItem, breakdownRows, formatMinutes, formatShare, projectTree } from "@core/summary";
import { dot, el } from "./dom";

export interface BreakdownOptions {
  expanded: ReadonlySet<string>; // project paths whose rows are open
  toggle(path: string): void;
}

export function breakdownTable(
  items: readonly TaskItem[],
  total: number,
  colors: Map<string, string>,
  options: BreakdownOptions,
): HTMLElement {
  const wrap = el("div", "table-wrap");
  const table = el("table", "entry-table breakdown");
  const head = el("tr");
  head.append(el("th", null, "Project | task"), el("th", "num", "Duration"), el("th", "num", "Duration %"));
  const body = el("tbody");
  table.append(el("thead"), body);
  table.querySelector("thead")?.append(head);

  const share = (minutes: number) => formatShare(minutes, total);
  for (const row of breakdownRows(projectTree(items), options.expanded)) {
    if (row.kind === "task") {
      const line = el("tr", "task-row");
      const name = el("td");
      name.style.paddingLeft = `${26 + row.depth * 20}px`;
      name.append(el("span", "muted", "· "), document.createTextNode(row.task.description));
      if (row.task.count > 1) name.append(el("span", "muted small", ` ×${row.task.count}`));
      line.append(name, el("td", "num", formatMinutes(row.task.minutes)), el("td", "num", share(row.task.minutes)));
      body.append(line);
      continue;
    }

    const line = el("tr", row.depth === 0 ? "project-row" : "subproject-row");
    const name = el("td");
    name.style.paddingLeft = `${8 + row.depth * 20}px`;
    if (row.expandable) {
      const toggle = el("button", "chevron", row.open ? "▾" : "▸");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(row.open));
      toggle.title = row.open ? "collapse" : "expand";
      toggle.addEventListener("click", () => options.toggle(row.path));
      name.append(toggle);
    } else {
      name.append(el("span", "chevron-space"));
    }
    name.append(dot(colors.get(row.path)), el("span", row.depth === 0 ? "lane-name" : null, row.label));
    line.append(name, el("td", "num", formatMinutes(row.minutes)), el("td", "num", share(row.minutes)));
    body.append(line);
  }

  const totalRow = el("tr", "total-row");
  totalRow.append(
    el("td", "lane-name", "TOTAL"),
    el("td", "num", formatMinutes(total)),
    el("td", "num", total > 0 ? "100%" : "0%"),
  );
  body.append(totalRow);
  wrap.append(table);
  return wrap;
}
