// Turns an HTML day page into the task-list form the parser reads.
//
//     <h1>26/10</h1>             the date: the first date-like text outside a list item
//     <li>-7:26 API review</li>    one entry per list item
//
// Each converted line stays on the line where its element starts, so the line numbers in the
// output match the HTML file.
import { parse } from "parse5";

import { TimeParseError } from "./errors";
import { HEADER_RE as DATE_TEXT } from "./header";


interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlNode[];
  sourceCodeLocation?: { startLine: number } | null;
}

const collapse = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
const lineOf = (node: HtmlNode) => node.sourceCodeLocation?.startLine ?? 0;

function textOf(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textOf).join("");
}

// How many lines of text a list item has: its text, split at each line break. A trailing break adds nothing.
function linesOf(node: HtmlNode): number {
  let lines = 0;
  let current = "";
  const visit = (child: HtmlNode): void => {
    if (child.tagName === "br") {
      if (current.trim()) lines += 1;
      current = "";
      return;
    }
    if (child.nodeName === "#text") current += child.value ?? "";
    for (const grandchild of child.childNodes ?? []) visit(grandchild);
  };
  for (const child of node.childNodes ?? []) visit(child);
  if (current.trim()) lines += 1;
  return lines;
}

function hasDescendant(node: HtmlNode, test: (child: HtmlNode) => boolean): boolean {
  return (node.childNodes ?? []).some((child) => test(child) || hasDescendant(child, test));
}

export function looksLikeHtml(text: string): boolean {
  return text.trimStart().startsWith("<");
}

export function htmlToMarkdown(text: string): string {
  const document = parse(text, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
  const outside: [number, string][] = [];
  const items: [number, string][] = [];

  const walk = (node: HtmlNode): void => {
    if (node.nodeName === "#text") {
      const value = node.value ?? "";
      if (value.trim()) outside.push([lineOf(node), collapse(value)]);
      return;
    }
    if (node.tagName === "li") {
      // One entry is one list item on one line. A nested item or a line break would be read as part
      // of this entry's text, so the entry would silently lose its own text: refuse it instead.
      if (hasDescendant(node, (child) => child.tagName === "li")) {
        throw new TimeParseError(`line ${lineOf(node)}: a list item holds another list item; give each entry its own list item`);
      }
      if (linesOf(node) > 1) {
        throw new TimeParseError(`line ${lineOf(node)}: a list item spans more than one line; put each entry in its own list item on its own line`);
      }
      const body = collapse(textOf(node));
      if (body) items.push([lineOf(node), body]);
      return;
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(document);

  const header = outside.find(([, body]) => DATE_TEXT.test(body));
  if (!header) throw new TimeParseError("missing header: no date such as 26/10 found in the HTML");

  const lines = new Map<number, string>([[header[0], header[1]]]);
  for (const [line, body] of items) {
    if (lines.has(line)) {
      throw new TimeParseError(`line ${line}: more than one entry on this line; put each list item on its own line`);
    }
    lines.set(line, `- [ ] ${body}`);
  }

  const total = Math.max(text.split(/\r\n|\r|\n/).length, ...lines.keys());
  return Array.from({ length: total }, (_, index) => lines.get(index + 1) ?? "").join("\n") + "\n";
}
