#!/usr/bin/env node
// Builds the installable web app into site/: the bundle (named by content hash), index.html, the
// manifest, the service worker, the icons and a 404 page that goes to the start page.
//   node scripts/build-site.mjs              (SITE_BASE defaults to /time-tracker/, the Pages path)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const BASE = process.env.SITE_BASE ?? "/time-tracker/";
const THEME = "#4f8cf0";
const BACKGROUND = "#f5f6f8";

rmSync(SITE, { recursive: true, force: true });
mkdirSync(join(SITE, "assets"), { recursive: true });

const result = await build({
  entryPoints: [join(ROOT, "viewer", "src", "entry-web.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outdir: join(SITE, "assets"),
  entryNames: "app-[hash]",
  metafile: true,
  write: true,
  logLevel: "warning",
});
const outputs = Object.keys(result.metafile.outputs).map((path) => join(ROOT, path));
const script = outputs.find((path) => path.endsWith(".js"));
const style = outputs.find((path) => path.endsWith(".css"));
if (!script || !style) throw new Error("the bundle did not produce a script and a stylesheet");
const assetName = (path) => path.slice(path.indexOf(join("site", "assets")) + join("site", "assets").length + 1);
const scriptFile = `assets/${assetName(script)}`;
const styleFile = `assets/${assetName(style)}`;

cpSync(join(ROOT, "viewer", "web", "icons"), join(SITE, "icons"), { recursive: true });
copyFileSync(join(ROOT, "viewer", "web", "icons", "apple-touch-icon.png"), join(SITE, "apple-touch-icon.png"));

const manifest = {
  name: "Time Parser",
  short_name: "Time",
  description: "Write and report your day's time entries. Works offline.",
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "portrait",
  theme_color: THEME,
  background_color: BACKGROUND,
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
writeFileSync(join(SITE, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");

const page = readFileSync(join(ROOT, "viewer", "app.html"), "utf-8")
  .replace('<link rel="stylesheet" href="dist/app.css">', [
    `<link rel="stylesheet" href="${styleFile}">`,
    `<meta name="theme-color" content="${THEME}">`,
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Time Parser">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  ].join("\n  "))
  .replace('<script src="dist/app.js"></script>', `<script src="${scriptFile}"></script>`);
if (page.includes("dist/")) throw new Error("index.html still points at the server build");
writeFileSync(join(SITE, "index.html"), page);

writeFileSync(
  join(SITE, "404.html"),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Time Parser</title>
  <script>
    // GitHub Pages serves this page for a path it does not have. The app is one page: go to its start.
    location.replace(${JSON.stringify(BASE)} + "index.html" + location.search);
  </script>
  <meta http-equiv="refresh" content="0; url=${BASE}index.html">
</head>
<body><a href="${BASE}index.html">Time Parser</a></body>
</html>
`,
);

// The files the service worker keeps. Its cache name is a hash of their content.
const precache = ["./", "./index.html", "./404.html", "./manifest.webmanifest", `./${scriptFile}`, `./${styleFile}`,
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./apple-touch-icon.png"];
const digest = createHash("sha256");
for (const path of precache) digest.update(readFileSync(join(SITE, path === "./" ? "index.html" : path)));
const cacheName = `time-parser-${digest.digest("hex").slice(0, 16)}`;
const worker = readFileSync(join(ROOT, "viewer", "web", "sw.template.js"), "utf-8")
  .replace('"__CACHE__"', JSON.stringify(cacheName))
  .replace("__PRECACHE__", JSON.stringify(precache));
writeFileSync(join(SITE, "sw.js"), worker);
writeFileSync(join(SITE, ".nojekyll"), "");

console.log(`site/ built: ${scriptFile}, ${styleFile}, cache ${cacheName}`);
