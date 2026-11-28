import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskItem,
  annularSectorPath,
  projectTree,
  sunburstArcs,
  sunburstCentre,
  sunburstHasChildren,
  sunburstParent,
  sunburstSlices,
  sunburstVisibleLabel,
  sunburstZoom,
} from "../src/core/summary";

const item = (project: string, minutes: number | null): TaskItem => ({ project, duration_minutes: minutes, description: "x" });
const FULL = 2 * Math.PI;
const EPS = 1e-9;

const sample = () =>
  projectTree([
    item("a:1", 60),
    item("a:2", 30),
    item("a", 15), // the parent's own time: the rest of its arc
    item("b", 45),
    item("b:x", 45),
    item("unknown", 30),
    item("idle", null), // no time, so no arc
  ]);

test("top-level arcs cover the whole circle, in proportion to their minutes", () => {
  const arcs = sunburstArcs(sample()).filter((arc) => arc.depth === 0);

  const covered = arcs.reduce((sum, arc) => sum + (arc.end - arc.start), 0);
  assert.ok(Math.abs(covered - FULL) < EPS, `top-level arcs cover ${covered}, not 2π`);
  assert.deepEqual(
    arcs.map((arc) => arc.path),
    ["a", "b", "unknown"],
  );
  const a = arcs[0];
  assert.ok(Math.abs((a.end - a.start) / FULL - 105 / 225) < EPS, "a is 105 of the 225 minutes in the sample");
});

test("each child arc lies inside its parent's arc, and children do not overlap", () => {
  const arcs = sunburstArcs(sample());
  const byPath = new Map(arcs.map((arc) => [arc.path, arc]));

  for (const arc of arcs) {
    const parentPath = arc.path.includes(":") ? arc.path.slice(0, arc.path.lastIndexOf(":")) : null;
    if (!parentPath) continue;
    const parent = byPath.get(parentPath);
    assert.ok(parent, `parent ${parentPath} of ${arc.path}`);
    assert.ok(arc.start >= parent.start - EPS && arc.end <= parent.end + EPS, `${arc.path} inside ${parentPath}`);
  }

  const children = arcs.filter((arc) => arc.path.startsWith("a:"));
  const [first, second] = children;
  assert.ok(Math.abs(first.end - second.start) < EPS, "the children of a sit side by side, without overlap");
});

test("an arc spans its minutes exactly: 60 minutes of a day is a sixth of the circle at 360 minutes", () => {
  const arcs = sunburstArcs(projectTree([item("p", 60), item("q", 300)]));
  const p = arcs.find((arc) => arc.path === "p");
  assert.ok(p);
  assert.ok(Math.abs(p.end - p.start - FULL / 6) < EPS);
  assert.equal(p.minutes, 60);
});

test("projects with no time get no arc, and neither does anything below them", () => {
  const arcs = sunburstArcs(projectTree([item("idle", null), item("idle:x", null)]));
  assert.deepEqual(arcs, []);
});

test("a ring is one level deeper per sub-project level, and children sit further out", () => {
  const slices = sunburstSlices(sample(), { radius: 100, hole: 20 });
  const top = slices.find((slice) => slice.path === "a");
  const child = slices.find((slice) => slice.path === "a:1");
  assert.ok(top && child);
  assert.equal(top.depth, 0);
  assert.equal(child.depth, 1);
  assert.ok(Math.abs(top.inner - 20) < EPS);
  assert.ok(Math.abs(top.outer - 60) < EPS, "two levels share the 80 units of radius, so each ring is 40 deep");
  assert.ok(child.inner >= top.outer - EPS, "a child ring starts where its parent ring ends");
  assert.ok(Math.abs(child.outer - 100) < EPS, "the outer ring ends at the radius");
});

test("the arc path starts on the outer circle at twelve o'clock and is closed", () => {
  const path = annularSectorPath(0, 0, 40, 100, 0, Math.PI / 2);
  assert.ok(path.startsWith("M 0.000 -100.000 "), path);
  assert.ok(path.endsWith("Z"), path);
  assert.match(path, /A 100 100 0 0 1 100\.000 0\.000/); // a quarter turn ends at three o'clock
});

test("a single project with the whole day is drawn as two half arcs, so it still closes", () => {
  const [slice] = sunburstSlices(projectTree([item("only", 480)]), { radius: 100, hole: 20 });
  assert.equal((annularSectorPath(0, 0, 20, 100, 0, FULL).match(/A /g) ?? []).length, 4);
  assert.ok(slice.end - slice.start > FULL - EPS);
});

const GEOMETRY = { radius: 100, hole: 20 };

test("zoomed out, the chart keeps every slice", () => {
  const slices = sunburstSlices(sample(), GEOMETRY);
  assert.deepEqual(sunburstZoom(slices, null, GEOMETRY), slices);
});

test("zoomed into a project, its children fill the whole circle on the innermost ring", () => {
  const slices = sunburstSlices(sample(), GEOMETRY);
  const zoomed = sunburstZoom(slices, "a", GEOMETRY);

  assert.deepEqual(
    zoomed.map((slice) => slice.path),
    ["a:1", "a:2"],
  );
  const covered = zoomed.reduce((sum, slice) => sum + (slice.end - slice.start), 0);
  assert.ok(Math.abs(covered - FULL) < EPS, `children cover ${covered}, not 2π`);
  const [first, second] = zoomed;
  assert.ok(Math.abs((first.end - first.start) / FULL - 60 / 90) < EPS, "a:1 is 60 of the 90 minutes under a");
  assert.ok(Math.abs(first.end - second.start) < EPS, "the children sit side by side");
  for (const slice of zoomed) {
    assert.equal(slice.depth, 0);
    assert.ok(Math.abs(slice.inner - GEOMETRY.hole) < EPS);
    assert.ok(Math.abs(slice.outer - GEOMETRY.radius) < EPS);
  }
});

test("zoomed into a project with grandchildren, they move in one ring and keep their order", () => {
  const nested = sunburstSlices(projectTree([item("p", 30), item("p:x", 30), item("p:x:deep", 30), item("p:y", 30)]), GEOMETRY);
  const zoomed = sunburstZoom(nested, "p", GEOMETRY);

  assert.deepEqual(
    zoomed.map((slice) => [slice.path, slice.depth]),
    [
      ["p:x", 0],
      ["p:x:deep", 1],
      ["p:y", 0],
    ],
  );
  const deep = zoomed.find((slice) => slice.path === "p:x:deep");
  assert.ok(deep && Math.abs(deep.outer - GEOMETRY.radius) < EPS && deep.inner > GEOMETRY.hole);
});

test("zoomed into a project with no children, or a name not in the chart, the chart is unchanged", () => {
  const slices = sunburstSlices(sample(), GEOMETRY);
  assert.deepEqual(sunburstZoom(slices, "unknown", GEOMETRY), slices);
  assert.deepEqual(sunburstZoom(slices, "nope", GEOMETRY), slices);
});

test("a project has children only when a slice sits below it", () => {
  const slices = sunburstSlices(sample(), GEOMETRY);
  assert.equal(sunburstHasChildren(slices, "a"), true);
  assert.equal(sunburstHasChildren(slices, "a:1"), false);
  assert.equal(sunburstHasChildren(slices, "unknown"), false);
});

test("the way back from a project is its parent, and from a top-level project is the whole chart", () => {
  assert.equal(sunburstParent("a:1:deep"), "a:1");
  assert.equal(sunburstParent("a:1"), "a");
  assert.equal(sunburstParent("a"), null);
});

test("a label that fits its slice is shown in full", () => {
  const [slice] = sunburstSlices(projectTree([item("gym", 60), item("q", 300)]), GEOMETRY).filter((s) => s.path === "gym");
  assert.equal(sunburstVisibleLabel(slice, 10), "gym");
});

test("a label too long for its slice is shortened with an ellipsis, and the shortened text is a prefix of it", () => {
  const slices = sunburstSlices(projectTree([item("client-long-name-for-report", 60), item("q", 300)]), GEOMETRY);
  const slice = slices.find((s) => s.path === "client-long-name-for-report");
  assert.ok(slice);
  const visible = sunburstVisibleLabel(slice, 10);
  assert.ok(visible !== null && visible.endsWith("…"), `shortened, got ${visible}`);
  assert.ok(visible.length < slice.label.length, "shorter than the label");
  assert.ok(slice.label.startsWith(visible.slice(0, -1)), "the start of the name, not other text");
  const available = Math.min((slice.end - slice.start) * ((slice.inner + slice.outer) / 2), slice.outer - slice.inner);
  assert.ok(visible.length * 10 * 0.6 <= available + EPS, `${visible} fits in ${available}`);
});

test("a slice too narrow for two characters and an ellipsis has no visible label", () => {
  const slices = sunburstSlices(projectTree([item("tiny", 1), item("big", 999)]), GEOMETRY);
  const tiny = slices.find((s) => s.path === "tiny");
  assert.ok(tiny);
  assert.equal(sunburstVisibleLabel(tiny, 10), null);
});

test("the centre shows the overall total when not zoomed, and the zoomed project's subtotal when zoomed", () => {
  const slices = sunburstSlices(sample(), GEOMETRY);
  const total = 225; // 60 + 30 + 15 + 45 + 45 + 30; the idle project has no time
  assert.deepEqual(sunburstCentre(slices, null, total), { name: "All", minutes: total });
  assert.deepEqual(sunburstCentre(slices, "a", total), { name: "a", minutes: 105 }); // its own 15 and its children's 90
  assert.deepEqual(sunburstCentre(slices, "b", total), { name: "b", minutes: 90 });
  assert.deepEqual(sunburstCentre(slices, "nope", total), { name: "All", minutes: total }); // not in the chart: no zoom
});
