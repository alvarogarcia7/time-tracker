import test from "node:test";
import assert from "node:assert/strict";

import { TimeParseError, parseDay, SCHEMA_REFERENCE } from "../src/core/parser";
import { htmlToMarkdown, looksLikeHtml } from "../src/core/html";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PARSED_AT = "2026-11-11T12:00:00+04:00";
const PAGE = `<div><br><h1> 26/10</h1></div>
<ul>
<li>-7:26 API review </li>
<li>1650 be with Sam</li>
<li>-1:11 API review</li>
<li>19:39 gym</li>
</ul>
`;
const MARKDOWN = "#toggl 26/10\n- [ ] -7:26 API review \n- [ ] 1650 be with Sam\n- [ ] -1:11 API review\n- [ ] 19:39 gym\n";

const parse = (text: string) => parseDay(text, { defaultYear: 2026, parsedAt: PARSED_AT });

function expectThrows(fn: () => unknown, pattern?: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof TimeParseError, `expected TimeParseError, got ${String(err)}`);
    if (pattern) assert.match((err as Error).message, pattern);
    return true;
  });
}

test("the page gives the expected entries", () => {
  const result = parse(PAGE);

  assert.equal(result.date, "2026-10-26");
  assert.equal(result.tag, null);
  assert.deepEqual(
    result.entries.map((e) => [e.line, e.start, e.end, e.start_type, e.time_expression, e.duration_minutes, e.description]),
    [
      [3, "09:24", "16:50", "relative", "-7:26", 446, "API review"],
      [4, "16:50", "18:28", "absolute", "1650", 98, "be with Sam"],
      [5, "18:28", "19:39", "relative", "-1:11", 71, "API review"],
      [6, "19:39", null, "absolute", "19:39", null, "gym"],
    ],
  );
});

test("the original text is the HTML as received", () => {
  assert.equal(parse(PAGE).original_text, PAGE);
});

test("list items keep their line numbers", () => {
  const converted = htmlToMarkdown(PAGE).split("\n").slice(0, -1);

  assert.equal(converted.length, PAGE.split("\n").length);
  assert.equal(converted[0], "26/10");
  assert.equal(converted[2], "- [ ] -7:26 API review");
});

test("the header can carry a tag", () => {
  assert.equal(parse("<h1>#toggl 26/10</h1>\n<li>0800 coffee</li>\n").tag, "toggl");
});

test("a full date in the header", () => {
  assert.equal(parse("<h1>26/10/2025</h1>\n<li>0800 coffee</li>\n").date, "2025-10-26");
});

test("a page without a date is rejected", () => {
  expectThrows(() => parse("<ul>\n<li>0800 coffee</li>\n</ul>\n"), /no date/);
});

test("two items on one line are rejected", () => {
  expectThrows(() => parse("<h1>26/10</h1>\n<li>0800 a</li><li>0900 b</li>\n"), /line 2/);
});

test("an entry that passes midnight in an HTML page", () => {
  const entries = parse("<h1>26/10</h1>\n<li>2334 API review</li>\n<li>03:13 sleep</li>\n").entries;

  assert.deepEqual(entries.map((e) => [e.start, e.end, e.duration_minutes]), [
    ["23:34", "03:13", 219],
    ["03:13", null, null],
  ]);
});

test("entities and nested tags are text", () => {
  assert.equal(parse("<h1>26/10</h1>\n<li><b>0800</b> R&amp;D</li>\n").entries[0].description, "R&D");
});

test("HTML is detected from the first character", () => {
  assert.equal(looksLikeHtml(PAGE), true);
  assert.equal(looksLikeHtml("  \n<div>"), true);
  assert.equal(looksLikeHtml("#toggl 11/11\n- [ ] 0800 a\n"), false);
});

test("the HTML page and the Markdown day give the same entries", () => {
  const md = parse(MARKDOWN);
  const html = parse(PAGE);

  assert.equal(md.date, html.date);
  assert.equal(md.entries.length, html.entries.length);
  md.entries.forEach((mdEntry, index) => {
    const { line: _mdLine, source: _mdSource, ...mdRest } = mdEntry;
    const { line: _htmlLine, source: _htmlSource, ...htmlRest } = html.entries[index];
    assert.deepEqual(mdRest, htmlRest, mdEntry.description);
  });
});

test("HTML lines are one below the Markdown lines, because of the ul", () => {
  const md = parse(MARKDOWN).entries.map((e) => e.line);
  const html = parse(PAGE).entries.map((e) => e.line);

  assert.deepEqual(html.map((line, index) => line - md[index]), [1, 1, 1, 1]);
});

test("a date-only Markdown header parses, with tag null", () => {
  const result = parse("11/11\n- [ ] 0800 a\n- [ ] \n");

  assert.equal(result.date, "2026-11-11");
  assert.equal(result.tag, null);
  assert.equal(result.entries[0].description, "a");
});

test("a Markdown header with a tag still parses", () => {
  assert.equal(parse("#toggl 11/11\n- [ ] 0800 a\n").tag, "toggl");
});

test("the schema allows a null tag", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "..", SCHEMA_REFERENCE), "utf-8"));

  assert.deepEqual(schema.properties.tag.type, ["string", "null"]);
  assert.equal(schema.version, "1.2.0");
});

test("an HTML heading with a heading marker and no tag: # 17/11", () => {
  const result = parse("<h1># 17/11</h1>\n<li>0800 a</li>\n");

  assert.equal(result.date, "2026-11-17");
  assert.equal(result.tag, null);
});

// An item with a nested item or a line break in the middle would lose its own text, so it is refused.
test("a list item that holds another item is refused, not merged into its entry", () => {
  const html = "<h1>11/11</h1>\n<ul>\n<li>0900 gym\n<ul>\n<li>1000 misc</li>\n</ul>\n</li>\n<li>1100 client-b</li>\n</ul>\n";
  assert.throws(() => htmlToMarkdown(html), /line 3: a list item holds another list item/);
});

test("a list item with a line break in the middle is refused, not merged", () => {
  const html = "<h1>11/11</h1>\n<ul>\n<li>0900 gym<br>1000 misc</li>\n</ul>\n";
  assert.throws(() => htmlToMarkdown(html), /line 3: a list item spans more than one line/);
});

test("a trailing line break in a list item is harmless", () => {
  const html = "<h1>11/11</h1>\n<ul>\n<li>0900 gym<br></li>\n</ul>\n";
  assert.equal(htmlToMarkdown(html).split("\n")[2], "- [ ] 0900 gym");
});
