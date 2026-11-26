# time-parser

Parses a day of time entries written as a task list into JSON, with reports, a viewer, an editor, and an installable web app that works offline.

```
#toggl 11/11
- [ ] 8 X
- [ ] 859 watch tv, lost
- [ ] -1:10 8
- [ ] 1106 gym
- [ ]
```

## The web app

The app is at **https://alvarogarcia7.github.io/time-tracker/**. It has four tabs for a day and its projects, and a Settings tab:

- **Editor:** create today's day (or any date), then edit it as an entries table or as plain text. The parser's start and end times are shown, and a file that does not parse can still be saved.
- **Viewer:** a day as a timeline and by project; the Week switch shows the Monday-to-Sunday week.
- **Reports:** hours by period, project and category, as `make report` does.
- **Projects:** the project database (`projects.yml`), as a table and as text.
- **Settings:** sync through a private repository, and export and import of the backup.

Everything is computed in the browser. The days are stored on the device, in the browser's IndexedDB storage. Nothing is sent anywhere unless you set up sync.

### Install on iPhone

1. Open https://alvarogarcia7.github.io/time-tracker/ in Safari.
2. Tap Share, then **Add to Home Screen**.
3. Open Time Parser from the home screen. It opens full screen, like an app.

### Offline

- The first visit caches the app (a service worker). After that the app opens without a connection, and the days on the device are there.
- Edits made offline are saved on the device. Sync waits for a connection.
- iOS does not run background sync, so the app syncs when it is opened, when the connection comes back, and when you press **Sync now** in Settings. Without a connection the app says that changes are kept on the device.
- The browser may clear a site's data. Settings asks the browser to keep it, but keep an export backup as well (Settings > Export backup).

### Sync through a private repository

Sync keeps the day files in a private GitHub repository, `time-tracker-data` by default, so your devices share them.

1. Create a private repository for the day files (for example `time-tracker-data`).
2. Create a fine-grained personal access token on GitHub: resource owner your account, repository access only that repository, and the permission **Contents: Read and write**.
3. In the app, open Settings, enter the GitHub owner and the repository name, paste the token, and press **Save settings**. The token is stored only in the browser of this device and is not shown again. **Forget token** removes it.
4. Press **Sync now**. Each day file is compared with the copy on GitHub. A change on one side is copied to the other. The sync runs again each time the app opens.

If the same day changed on two devices between two syncs, nothing is lost: the GitHub version stays as the day file, and this device's version is saved beside it as `<day>.conflict-<device>-<time>.md`. Open both, keep what you need, and delete the copy.

### Backup

Settings > Export backup writes every day file and the project database to one JSON file (the iOS Share sheet is used where available). Each file can also be downloaded on its own. Import reads such a file back: it adds what is missing, and a file whose text differs is never overwritten. The imported text is saved as a copy with a `.conflict-<time>` name, and the import says so.

## Building and testing

Requires Node.js 22 or later.

```
make install     # npm packages
make build       # dist/cli.js, the editor page, and the web app in site/
make test        # unit tests
make check       # type check
make serve       # the web app at http://127.0.0.1:4173/time-tracker/
make e2e         # browser tests of the web app (Chromium; WebKit when it is installed)
make editor      # the editor server for a folder of day files (see Web editor)
```

`make e2e` runs Playwright. Install its browsers once with `npx playwright install chromium webkit`. The GitHub Actions workflow in `.github/workflows/pages.yml` runs the tests on every push and pull request, deploys the site from `main` to GitHub Pages, and runs the smoke tests (`@smoke`) against the deployed site.

`make icons` regenerates the PNG icons (`viewer/web/icons`) from `scripts/make-icons.mjs`.

## Setup

The program is one command-line tool, `node dist/cli.js`, with these commands: `parse`, `convert`, `view`, `report`, `suggest` and `editor`. `node dist/cli.js help` lists them. The web app and the editor page call the same library functions as the command line. The editor server (`make editor`) keeps the files on disk and serves the page over HTTP; the web app keeps them in the browser.

## Descriptions

The description of an entry can name its project and give its task:

```
kitchen: wash dishes     kitchen, wash dishes
wash dishes, kitchen     wash dishes: kitchen
```

The side that is a project keyword gives the project (matched ignoring case, a whole text, so `client-a team` works as a keyword of several words). The other side is the task, kept as written, and is output as `task`. The separators are `:` and `,`; the first and the last one are both tried, so a task may contain a comma. A description with no such split takes the project of a keyword found anywhere in it, and its task is the whole description. Two different projects on the two sides is an error.

## Format

- **Header**: the date alone, `DD/MM` or `DD/MM/YYYY`, or with a tag before it and text after it, such as `#toggl 6/5`, `toggl 6/5`, `# Toggl 6/5 Partial` or `#Toggl 6/5`. The tag is matched in any case, with or without `#`. Without a year, the current year is used (or `--year`). Without a tag, the output's `tag` is `null`.
- **HTML pages**: a `.html` file works too. The date is the first date-like text outside a list item (such as an `<h1>`), and each `<li>` is one entry. Each entry keeps its line number from the HTML file. Each list item must be on its own line.
- **Entries**: `- [ ] <time> <description>`. An entry runs until the next entry starts. The checkbox is optional.
- **Absolute times** (24 h): `8`, `08`, `859`, `0859`, `8:59`, `08:59`, `11`, `1100`, `11:00`. Minutes `00` and the leading zero are optional.
- **Relative times**:
  - `-d` is `d` before the start of the next entry (`-1:10 8` before `11:06` gives `09:56`). Consecutive `-d` entries are chained backwards from the absolute entry that ends the run, so each one lasts `d`: `-0:45`, `-1:10`, `-0:36` before `17:12` start at `14:41`, `15:26` and `16:36`.
  - `+d` is `d` after the start of the previous entry.
  - `d` is minutes when it is a bare number: `-30` is 30 minutes, `-100` is 100 minutes.
  - `d` is hours and minutes with a colon: `-1:30` is 90 minutes, `-1:00` is 60 minutes.
- **References**: a description that is only a time (`8`) takes the description of the nearest earlier entry starting at that time.
- **Projects**: a YAML mapping of project name to keywords. Keywords match whole words, ignoring case.
  - A keyword belongs to one project only. Listing the same keyword under two projects (ignoring case and surrounding spaces) is an error.
  - An entry whose description matches keywords of two unrelated projects is an error, naming the line. Projects in one line of descent are not unrelated (see Hierarchy below).
  - An entry that matches no keyword is `unknown`, which is reserved and cannot be a project name.
- Empty placeholder tasks (`- [ ]`) are ignored. The last entry has `end: null`.

## Usage

```
node dist/cli.js parse day.md --projects projects.yml --year 2026
cat day.md | node dist/cli.js parse --projects projects.yml
```

`projects.yaml` (see `tests/fixtures/sample/projects.yaml`):

```yaml
lost:
  - lost
gym:
  - gym
  - workout
client-a:
  - client-a
  - client-a team
```

Quote project names that YAML would read as another type, such as `"no"`. A duplicate project key is an error.

## Samples

The test fixtures in `tests/fixtures/sample/` are small, made-up days and project files:

- `day.md` and `week-day.md`: sample days.
- `projects.yaml`: a valid project file.
- `projects-conflict.yaml`: a file the parser rejects, because `workout` is listed under two projects.

`make samples` parses every sample day and checks that the conflicting file is rejected.

`tests/fixtures/sample/expected/` holds hand-written expected output for each sample day. `make check-samples` compares the parser's output with it, field by field.

Output is JSON with `date`, `parsed_at`, `original_text`, `parser_version`, `tag`, `entries`, and `schema`, which is the path of the versioned JSON Schema file that describes the output: `time_parser/schemas/time-entry-day-1.1.0-schema.json`. The schema is not embedded in the output. Its `version` and `$id` fields match the file name. The loaded schema is also available as `time_parser.parser.OUTPUT_SCHEMA`. Each entry has `line`, `source`, `start`, `end`, `start_type`, `time_expression`, `duration_minutes`, `description`, `project` and `reference`.

Errors exit with status 1 and name the offending line.

## Project database and reports

Projects live in a YAML database, `data/projects.yml` by default. Each project has keywords (matched against the descriptions) and an optional category, `personal` or `professional`:

```yaml
gym:
  category: personal
  keywords: [gym, workout]
client-b:api-review:
  category: professional
  keywords: ["API review"]
```

Names can be hierarchical (`a:b:c`). The older form, keywords only, still loads.

Hierarchy: a project named `a:b` is below `a`, and a keyword of `a` also matches `a:b`. When several projects match, the deepest one wins, and a project matched by its own keyword beats one matched only through its parent at the same depth. So with `car` (keyword `car`) and `car:maintainance` (keyword `car:maintainance`), `car`, `car wash` and `car: wash` are all `car:maintainance`. Two projects that are not in one line of descent (`gym` and `car:maintainance` matching the same description) is still an error. A description that is exactly a keyword is matched as a whole first, so a keyword with a colon is not split. `tests/fixtures/sample/projects.yml` is a categorised example.

Projects in the time entries that are not registered are added to the same file as comments, between two marker lines. Uncomment one to accept it, rename it if needed, and add a category. Each suggestion lists its keywords one per line. `make sync-projects` only adds: it never changes or removes a line, and skips a project whose name or keyword is already in the file.

```
make sync-projects DATA_DIR=data
```

Reports compute hours from the parser output in `DATA_DIR`. Projects are matched again against the database on each run, so edits apply at once.

```
make report DATA_DIR=data PERIOD=monthly
make report DATA_DIR=data PERIOD=weekly FROM=2026-11-01 TO=2026-11-30
make report DATA_DIR=data PROJECT=gym,client-b:review         # exact project names
make report DATA_DIR=data PREFIX=client-b                     # client-b and every client-b:...
make report DATA_DIR=data CATEGORY=professional
make report DATA_DIR=data FORMAT=json
```

`PERIOD` is `daily`, `weekly` (ISO weeks, Monday first), `monthly`, `quarterly` or `yearly`. Periods with no entries show as zero. Hours are counted for closed entries; open entries (no end time) are shown separately. The same command without make: `node dist/cli.js report DATA_DIR --db FILE ...`.

## Web editor

`make editor` opens a local editor for the `.md` day files in `EDITOR_DIR` (default `data`). It runs on `127.0.0.1` and only reads and writes `.md` files in that folder. The same page is the web app above, with the files on disk instead of in the browser.

- **Plain text:** the whole file, with no restrictions.
- **Entries:** a table with the start and end times worked out by the parser. Times, descriptions and projects are dropdowns with suggestions, and free text is still accepted. Choosing a project adds its first keyword to the description, because the project comes from the keywords. If that would give two projects, the editor shows the clash and changes nothing. A project that is not in `projects.yml` yet is added there automatically, with its name as keyword; the file's existing text is kept. A reference such as `8` copies the description of the entry it points to, as in the parser, so choosing a project on it writes the copied text and the keyword into the line. You can also add an entry after another one, or delete one.

Save with the button or Ctrl+S. The previous version of a file is kept in `build/editor-backups` (in the web app: in the browser's backups, not shown). A save is refused if the file changed on disk since it was opened; use Reload to see the new version. A file that does not parse can still be saved, and the error is shown.

```
make editor                        # data/*.md, project database data/projects.yml
make editor EDITOR_DIR=days DB=projects.yml EDITOR_PORT=8002
```

The same command without make: `node dist/cli.js editor FOLDER --db FILE --port PORT`.

## Viewer

The viewer tab shows a day: the one open in the editor, or one picked from the folder. The day is shared with the editor, so choosing a file in either tab selects it in both (a file with unsaved changes asks first). Its share of tracked time lists the projects as a tree: a project named `a:b:c` sits under `a:b`, which sits under `a`, and each row shows its total and its share of the day.

The Week switch shows the Monday-to-Sunday week that holds the selected day: totals, a bar per day stacked by project, each project's share, and a breakdown by project and task. The arrows move between weeks.

## Batch conversion

`make import` converts every `*.md` day file in a folder. Each `<name>.md` becomes `<name>.json` in the output folder, and a file that fails is reported while the rest still convert.

```
make import                                   # data/*.md -> data/*.json (same folder)
make import IN_DIR=days OUT_DIR=json          # other folders
make import PROJECTS=data/projects.yaml YEAR=2026
make import PATTERN="*.txt"                   # other file types
```

Equivalent command: `node dist/cli.js convert IN_DIR OUT_DIR --projects FILE --year YEAR`. The exit status is 1 when any file fails.

## View a parser output

`time_parser.viewer` shows a parser output file as text: the time entries, the entries grouped by project, or both.

```
node dist/cli.js view tests/fixtures/sample/expected/week-day.json
node dist/cli.js view data.json --view projects
make view JSON=tests/fixtures/sample/expected/day.json VIEW=entries
```

Projects are sorted by tracked time, and `unknown` is always last. Open entries are shown as `open` and counted separately.

## The page: one UI with tabs

`make editor` opens one page with four tabs. The editor server serves it, so every tab works on the files in the folder. The web app has the same four tabs and a Settings tab:

- **Editor:** the day files, as plain text or as an entries table (see Web editor above).
- **Viewer:** a day as a timeline with one coloured lane per project and the entries grouped by project. It shows the day open in the editor, or a day picked from the folder, or a parser output file dropped on the page. Open entries are striped.
- **Reports:** the reports panel, the browser version of `make report`: choose the period, a range (this or last week or month fills the dates; or custom), projects and prefixes (picked from a dropdown or typed), and category. Its numbers match `node dist/cli.js report`, and the tests check both against the same fixtures.
- **Projects:** the project database as a table, a form to add a project, and the whole `projects.yml` as text. Saving checks the text as a project database first, and refuses a file that changed on disk since it was loaded. A backup of the previous text is kept in `build/editor-backups`.

```
make editor              # the page, for the .md files in data/ (Ctrl-C to stop)
make viewer-build        # rebuilds viewer/dist/app.js, the page's script
```

`make sync-projects` runs in the command line, because it writes files. Its web equivalent is editing the file in the Projects tab.

Text from the files is always shown with `textContent`, so descriptions are shown as plain text. The page's operations are one interface (`EditorApi` in `src/core/workspace.ts`): the server implements it over HTTP, and the web app runs the shared `DayService` over IndexedDB, with the storage contract of `src/core/workspace.ts`.

A new day: the New day control creates `YYYY-MM-DD.md` with the header `DD/MM/YYYY` for the chosen date.

## Limits

- One day per input.
- Entries are in order. An entry may pass midnight: its end may come on the next day, with a clock time earlier than its start (23:34 then 03:13 is one entry of 219 minutes). The entry before it must start after 21:00, and only one passage past midnight is allowed in a day.

## Tests

```
make test     # unit tests: parser, reports, editor server, sync against a fake GitHub
make e2e      # browser tests of the built web app (run make build first)
```

## Notes import (macOS)

Imports the Toggl notes exported by [Notes Exporter](https://github.com/storizzi/notes-exporter) (`exportnotes.zsh`, macOS only).

```
make notes-sync      # clones Notes Exporter if needed and runs zsh exportnotes.zsh -m
make notes-select    # copies the Toggl notes to data/in/YYYY-MM-DD-HH_MM_SS and writes its delete.sh
                     # NOTES_SELECT_ARGS='--exclude Work --include Work/Projects' chooses folders
make notes-import-review-commit   # converts the newest data/in folder, prints what to review and
                                 # to categorize (REPORT.txt), and commits the folder
bash data/in/<folder>/delete.sh  # only when the import is accepted: deletes the original notes
`notes-select` takes the export from `NOTES_EXPORT_ROOT_DIR` (default `~/Downloads/AppleNotesExport`). It selects the notes whose file name or title contains "toggl" (ignoring case), in every folder except the excluded ones. The folder is the note's subdirectory in the export (`iCloud-Work`, or `Work/Projects` with a nested layout). `--exclude FOLDER` leaves a folder out, `--include FOLDER` takes it back, and a folder name also covers its subfolders; the later and more specific rule wins. `iCloud-Recently-Deleted` is excluded by default. The notes left out are listed in the output and in `selection.json`. The date is read from the first line of each Markdown file (`6/5`, `6-5`, `6.5`, with or without a year), and falls back to the creation date. A file is listed for review when that date differs from the creation date, or when it cannot be converted. A file is listed for categorizing when an entry has no project. The report is also saved as `REPORT.txt` in the import folder. Importing a note again is safe: `data/in/imports.json` records each imported note, so a note that did not change in Apple Notes is skipped, and a changed one replaces its copy only when that copy was not edited. An edited copy is kept, and the Apple Notes version waits in `incoming/`; `make notes-keep-local FILE=...` or `make notes-take-incoming FILE=...` decides it. See [docs/notes-import.md](docs/notes-import.md).

`notes-select` deletes nothing: it writes `delete.sh`, which removes the original files of the selected notes: the Markdown file, and the same note in `raw/` and `html/` when those exist, and you run it yourself once you have accepted the import. `notes-import-review-commit` uses the newest folder in `data/in` unless you pass `IMPORT_DIR=`.
