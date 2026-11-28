// The sunburst of the times: inline SVG drawn from the pure geometry in src/core/summary.ts. The inner ring is
// the top-level projects, and each sub-project sits in the ring outside its parent. Clicking a slice that has
// children zooms the chart into it; the way back is the Up and All buttons, or a click on the centre. Every title
// and label is set with textContent, since project names come from the user's files.
import {
  TaskItem,
  UNKNOWN_COLOR,
  formatMinutes,
  formatShare,
  projectTree,
  sunburstHasChildren,
  sunburstParent,
  SunburstSlice,
  sunburstCentre,
  SunburstCentre,
  sunburstSlices,
  sunburstVisibleLabel,
  sunburstZoom,
} from "@core/summary";
import { el } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
const SIZE = 320; // the chart is a square of this many units
const RADIUS = SIZE / 2 - 4;
const HOLE = 52;
const GEOMETRY = { radius: RADIUS, hole: HOLE };
// A label is drawn only on a slice wide enough to hold it (in radians), so small slices stay unlabelled.
const LABEL_MIN_ANGLE = 0.35;
const LABEL_FONT_SIZE = 10; // the .sunburst-label font size in styles.css, which sunburstVisibleLabel fits labels to

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

interface Interactions {
  canZoom: (path: string) => boolean;
  onSlice: (path: string) => void; // a click on a slice that has children
  onCentre: (() => void) | null; // the way back, when the chart is zoomed in
}

export function sunburstChart(
  slices: readonly SunburstSlice[],
  colors: Map<string, string>,
  total: number,
  centre: SunburstCentre,
  interactions: Interactions,
): SVGSVGElement {
  // The chart fills the width of its container and scales with the viewBox, so it stays square and centred.
  const chart = svg("svg", {
    viewBox: `0 0 ${SIZE} ${SIZE}`,
    width: "100%",
    role: "img",
    class: "sunburst",
  });
  // The geometry is centred on (RADIUS, RADIUS), which is the middle of the square.
  const center = RADIUS;
  const group = svg("g", {});
  for (const slice of slices) {
    const zoomable = interactions.canZoom(slice.path);
    const path = svg("path", {
      d: slice.d,
      fill: colors.get(slice.path) ?? UNKNOWN_COLOR,
      class: zoomable ? "sunburst-slice zoomable" : "sunburst-slice",
    });
    const title = svg("title", {});
    title.textContent = `${slice.path}: ${formatMinutes(slice.minutes)} (${formatShare(slice.minutes, total)})`;
    path.append(title);
    if (zoomable) path.addEventListener("click", () => interactions.onSlice(slice.path));
    group.append(path);
  }
  for (const slice of slices) {
    if (slice.end - slice.start < LABEL_MIN_ANGLE) continue;
    // A label that does not fit is shortened or left out; its slice's hover title still gives the full name and time.
    const label = sunburstVisibleLabel(slice, LABEL_FONT_SIZE);
    if (label === null) continue;
    const middle = (slice.start + slice.end) / 2;
    const radius = (slice.inner + slice.outer) / 2;
    const text = svg("text", {
      x: formatPoint(center + radius * Math.sin(middle)),
      y: formatPoint(center - radius * Math.cos(middle) + 4),
      "text-anchor": "middle",
      class: "sunburst-label",
    });
    text.textContent = label;
    group.append(text);
  }
  if (interactions.onCentre) {
    const centre = svg("circle", { cx: String(center), cy: String(center), r: String(HOLE), class: "sunburst-centre" });
    centre.addEventListener("click", interactions.onCentre);
    group.append(centre);
  }
  // The centre names what the time is: "All" for the whole chart, or the zoomed project with its subtotal.
  const nameText = svg("text", { x: String(center), y: String(center - 6), "text-anchor": "middle", class: "sunburst-centre-name" });
  nameText.textContent = fitCentreName(centre.name);
  const totalText = svg("text", { x: String(center), y: String(center + 10), "text-anchor": "middle", class: "sunburst-total" });
  totalText.textContent = formatMinutes(centre.minutes);
  group.append(nameText, totalText);
  chart.append(group);
  return chart;
}

// The centre's name is shortened to the hole's width, so a long project name does not spill out of the chart.
const CENTRE_NAME_CHARS = 12;

function fitCentreName(name: string): string {
  return name.length > CENTRE_NAME_CHARS ? `${name.slice(0, CENTRE_NAME_CHARS - 1)}…` : name;
}

function formatPoint(value: number): string {
  return value.toFixed(1);
}

// The chart with a short caption. With no tracked time there is nothing to draw, so a note is shown instead.
export function sunburstBlock(items: readonly TaskItem[], colors: Map<string, string>): HTMLElement {
  const wrap = el("div", "sunburst-wrap");
  const tree = projectTree(items);
  const total = tree.reduce((sum, node) => sum + node.minutes, 0);
  if (total <= 0) {
    wrap.append(el("p", "muted", "No tracked time to chart."));
    return wrap;
  }
  const slices = sunburstSlices(tree, GEOMETRY);
  let zoomed: string | null = null;
  const zoom = (path: string | null): void => {
    zoomed = path;
    draw();
  };
  const draw = (): void => {
    const shown = sunburstZoom(slices, zoomed, GEOMETRY);
    const current = zoomed;
    const centre = sunburstCentre(slices, current, total);
    wrap.replaceChildren(
      zoomControls(current, (path) => zoom(path)),
      sunburstChart(shown, colors, total, centre, {
        canZoom: (path) => sunburstHasChildren(slices, path),
        onSlice: (path) => zoom(path),
        onCentre: current === null ? null : () => zoom(sunburstParent(current)),
      }),
      el("p", "muted small", "Inner ring: projects. Outer rings: their sub-projects. Arc size: time. Click a slice with sub-projects to zoom in."),
    );
  };
  draw();
  return wrap;
}

// The way back from a zoomed chart: All returns to the whole chart, and Up to the parent of the zoomed project.
function zoomControls(zoomed: string | null, zoom: (path: string | null) => void): HTMLElement {
  const nav = el("div", "sunburst-nav");
  if (zoomed === null) return nav;
  nav.append(el("span", "muted small", zoomed));
  const all = el("button", null, "All");
  all.type = "button";
  all.addEventListener("click", () => zoom(null));
  nav.append(all);
  const parent = sunburstParent(zoomed);
  if (parent !== null) {
    const up = el("button", null, "Up");
    up.type = "button";
    up.addEventListener("click", () => zoom(parent));
    nav.append(up);
  }
  return nav;
}
