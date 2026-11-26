#!/usr/bin/env node
// Serves site/ the way GitHub Pages does: under the project path (/time-tracker/), with 404.html for
// any path that has no file. Used by the browser tests and for a local look at the built app.
//   node scripts/serve-site.mjs [port] [base]     (defaults: 4173, /time-tracker/)
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const base = (process.argv[3] ?? process.env.SITE_BASE ?? "/time-tracker/").replace(/\/?$/, "/");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function fileFor(path) {
  const relative = normalize(path.slice(base.length)).replace(/^(\.\.[/\\])+/, "");
  let full = join(ROOT, relative);
  if (path.endsWith("/") || (existsSync(full) && statSync(full).isDirectory())) full = join(full, "index.html");
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = decodeURIComponent(url.pathname);
  if (path === "/") {
    response.writeHead(302, { Location: base });
    return response.end();
  }
  if (!path.startsWith(base)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("not found");
  }
  const found = fileFor(path);
  const file = found ?? join(ROOT, "404.html");
  const status = found ? 200 : 404;
  response.writeHead(status, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  response.end(readFileSync(file));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving site/ at http://127.0.0.1:${port}${base}`);
});
