# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node 22+. `npm install` once (or `make install`).

```
make check                 # tsc --noEmit
make test                  # npm test: compiles tests/*.test.ts to dist-test/, then node --test
make build                 # CLI (dist/cli.js), editor page (viewer/dist/app.js) and the web app (site/)
make e2e                   # Playwright against site/ (builds first)
make editor                # the local editor on 127.0.0.1:8001 for the .md days in data/
make serve                 # site/ at http://127.0.0.1:4173/time-tracker/
make samples check-samples # parse tests/fixtures/sample and compare with expected/*.json
```

Single test file (after `npm run test:build`):

```
node --test dist-test/sync.test.js
node --test --test-name-pattern="stale" dist-test/editorServer.test.js
```

Single Playwright test: `npx playwright test e2e/flows.spec.ts -g "three entries"`. Project names are `chromium-desktop` and `webkit-iphone` (`--project=...`). WebKit needs system libraries that this sandbox lacks; CI runs it. Set `E2E_BASE_URL` to run the same specs against the deployed site.

## Architecture

**One pure core, two shells.** `src/core/` holds all logic with no Node or browser APIs: the day parser (`parser.ts`, `header.ts`, `description.ts`, `html.ts`), the table model the editor uses (`editorModel.ts`), reports (`reports.ts`, `summary.ts`, `week.ts`), and the sync and bundle logic. It is bundled for the browser by esbuild, so new logic goes in `src/core` unless it touches disk or a browser API.

**Storage is one interface with two implementations.** `src/core/workspace.ts` defines `Storage` and `DayService` (create, read, write, and the project database). Every write takes the base text the user read and is refused with a 409 if the stored text changed. Implementations:
- `DiskStorage` in `src/node/editorServer.ts`, used by `make editor`. The page calls it over HTTP through `viewer/src/httpApi.ts`.
- IndexedDB in `viewer/src/web/idb.ts`, used by the installed web app. Its day and database writes check the stored text and write in one transaction.

The same UI runs on both. `viewer/src/app.ts`, `viewer/src/editor/app.ts` and the viewer tabs talk only to `EditorApi`. The two entry points are `viewer/src/entry-server.ts` (the editor served by Node) and `viewer/src/entry-web.ts` (the PWA). Changing editor behaviour usually means changing the shared UI plus, if it writes data, both storages.

**Sync is pull-then-push with conflict copies.** `src/core/sync.ts` works against two abstract sides (local and remote) and never overwrites: if both sides changed since the last sync, the remote text stays as the file and the local text is saved as `<name>.conflict-<device>-<time>.md`. `src/core/github.ts` is the remote, using the GitHub contents API against a private data repo (`time-tracker-data`) with a fine-grained token kept only in IndexedDB. `viewer/src/web/host.ts` runs syncs through `src/core/serial.ts` so they never overlap. Export and import (`src/core/bundle.ts`) use the same planning rules: an import never overwrites a differing file.

**PWA build.** `scripts/build-site.mjs` bundles `entry-web.ts` into `site/assets/app-<hash>.js`, writes the manifest and icons, and fills the precache list into `viewer/web/sw.template.js`. Paths are relative and the base is `/time-tracker/` (`SITE_BASE` overrides it), so the app works on GitHub Pages and locally.

**CLI.** `src/cli.ts` (bundled to `dist/cli.js`) exposes parse, convert, view, report, suggest and editor. `src/node/batch.ts` and `src/node/projectsFile.ts` are the Node-only parts (folders, the projects YAML file).

**Deploy.** `.github/workflows/pages.yml`: `verify` (check, test, build, Playwright in both projects) → `deploy` (main only, GitHub Pages) → `smoke` (the `@smoke` Playwright tests against the live URL). Pages must be set to "GitHub Actions" in the repo settings; the workflow cannot enable it with the default token.

## Constraints that are easy to break

- **No personal or work data in tracked files.** Real day files and the project database live in `data/` (gitignored) or the private `time-tracker-data` repo. Tests use the synthetic fixtures in `tests/fixtures/`. Do not add real project or client names to tests, docs or the README examples.
- **Never commit `.tokens`.** It holds the GitHub token and is gitignored; keep it out of commits, command lines and logs.
- **The parser's output schema is versioned.** `schemas/` holds the JSON Schema for each version; `tests/` checks the parser version matches `package.json`.
- The Pages site is public. Anything bundled into `site/` ships to users; never bundle tokens or data.
