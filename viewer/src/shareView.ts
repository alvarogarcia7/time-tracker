// The share of tracked time by project: one bar, and below it the projects as a tree. Shared by the
// viewer (one day or week) and the reports (the selected data), so both show the same thing.
import { ProjectTime, formatMinutes, formatShare, groupByProject, projectTree } from "@core/summary";
import { dot, el } from "./dom";

export function shareBlocks(items: readonly ProjectTime[], colors: Map<string, string>): HTMLElement[] {
  const groups = groupByProject(items);
  const total = groups.reduce((sum, group) => sum + group.minutes, 0);
  const bar = el("div", "share-bar");

  for (const group of groups) {
    if (group.minutes > 0 && total > 0) {
      const part = el("div", "share-part");
      part.style.width = `${(group.minutes / total) * 100}%`;
      part.style.background = colors.get(group.project) ?? "#888";
      part.title = `${group.project}: ${formatMinutes(group.minutes)} (${formatShare(group.minutes, total)})`;
      bar.append(part);
    }
  }
  return [bar, renderShareTree(projectTree(items), total, colors)];
}

// A project named a:b:c is listed under a:b, which is listed under a, and each row shows its total and its share.
function renderShareTree(nodes: ReturnType<typeof projectTree>, total: number, colors: Map<string, string>): HTMLElement {
  const list = el("ul", "share-tree");
  const add = (node: ReturnType<typeof projectTree>[number]) => {
    const row = el("li", node.children.length ? "share-row parent" : "share-row");
    const name = el("span", "share-name");
    name.style.paddingLeft = `${node.depth * 18}px`;
    name.append(dot(colors.get(node.path)), el("span", null, node.label));
    row.append(
      name,
      el("span", "share-time muted", formatMinutes(node.minutes)),
      el("span", "share-percent", formatShare(node.minutes, total)),
    );
    list.append(row);
    for (const child of node.children) add(child);
  };
  nodes.forEach(add);
  return list;
}
