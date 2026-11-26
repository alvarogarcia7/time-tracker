import test from "node:test";
import assert from "node:assert/strict";

import { EDITOR_TEMPLATE } from "../viewer/src/editor/template";

test("the Entries view says where an entry ends", () => {
  const section = EDITOR_TEMPLATE.slice(EDITOR_TEMPLATE.indexOf('<section id="entries-section">'), EDITOR_TEMPLATE.indexOf('<section id="plain"'));
  assert.match(section, /<p class="hint[^"]*">[^<]*ends where the next line starts[^<]*stays open[^<]*<\/p>/);
});
