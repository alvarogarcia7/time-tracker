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

The project of an entry is named after the last comma of its description:

```
wash dishes, kitchen
```

The text after the last comma is the project, matched against the project keywords, ignoring case and surrounding spaces. A keyword of several words works as a whole (`call, client-a team`). The text before that comma is the task, kept as written, so the task may contain commas: in `watch tv, a, lost` the task is `watch tv, a` and the project is `lost`. A comma tag that matches no project gives the project `unknown`, and the task is the text before the comma.

Without a comma tag, a colon splits the description, and the side that is a project keyword gives the project; the other side is the task. The forms are

```
kitchen: wash dishes     wash dishes: kitchen
```

The first and the last colon are both tried, so a task may contain a colon. Two different projects on the two sides is an error.

A description with no comma tag and no colon split takes the project of a keyword found anywhere in it, as a whole word, and its task is the whole description: `kitchen wash` is in `kitchen`. So `kitchen, wash` has the tag `wash`, so its project is `unknown` and its task is `kitchen`.

When several projects match, the deepest one wins. A project named `a:b` is below `a`, and a keyword of `a` also matches it (see Hierarchy below). At the same depth, a project matched by its own keyword beats one matched only through its parent. Two projects with their own keyword matching at the same depth are an error, naming them, and so is an unrelated match that is not above the chosen project. A description with no comma and no keyword is `unknown`.

## Format

- **Header**: the date alone, `DD/MM` or `DD/MM/YYYY`, or with a tag before it and text after it, such as `#toggl 6/5`, `toggl 6/5`, `# Toggl 6/5 Partial` or `#Toggl 6/5`. The tag is matched in any case, with or without `#`. Without a year, the current year is used (or `--year`). Without a tag, the output's `tag` is `null`.
- **HTML pages**: a `.html` file works too. The date is the first date-like text outside a list item (such as an `<h1>`), and each `<li>` is one entry. Each entry keeps its line number from the HTML file. Each list item must be on its own line.
- **Entries**: `- [ ] <time> <description>`. An entry runs until the next entry starts. The checkbox is optional.
- **Comments**: after the header, a line that starts with `#` is a comment, and the parser, the editor and the reports skip it. A new day starts with the line `# Date, description, project:b:c` after its header, as a reminder of the form of an entry.
- **Absolute times** (24 h): `8`, `08`, `859`, `0859`, `8:59`, `08:59`, `11`, `1100`, `11:00`. Minutes `00` and the leading zero are optional.
- **Relative times**:
  - `-d` is `d` before the start of the next entry (`-1:10 8` before `11:06` gives `09:56`). Consecutive `-d` entries are chained backwards from the absolute entry that ends the run, so each one lasts `d`: `-0:45`, `-1:10`, `-0:36` before `17:12` start at `14:41`, `15:26` and `16:36`.
  - `+d` is `d` after the start of the previous entry.
  - `d` is minutes when it is a bare number: `-30` is 30 minutes, `-100` is 100 minutes.
  - `d` is hours and minutes with a colon: `-1:30` is 90 minutes, `-1:00` is 60 minutes.
- **References**: a description that is only a time (`8`) takes the description of the nearest earlier entry starting at that time.
- **Projects**: a YAML mapping of project name to keywords. Keywords match whole words, ignoring case.
  - A keyword belongs to one project only. Listing the same keyword under two projects (ignoring case and surrounding spaces) is an error.
  - An entry whose keywords match two unrelated projects at the same depth is an error, naming the line (see Descriptions). Projects in one line of descent are not unrelated (see Hierarchy below).
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

## Saving the project database to GitHub

`make save` only saves: it commits `data/` locally and pushes nothing. `make sync` runs `make save`, then pushes the current branch to GitLab (`origin`, no force), and copies `data/projects.yml` to the GitHub data repository (`time-tracker-data`, branch `main`) as one commit. Only that file goes to GitHub; day files never do, and nothing is force-pushed. A failure of either push is reported, the other push still runs, and `make sync` exits non-zero if either failed. `make sync-projects-github` does only the GitHub step.

The copy is refused, and nothing changes on GitHub, when GitHub has a project the local file lacks, since pushing would delete it there. Merge the two files first, or set `SYNC_ALLOW_REMOVE=1` to allow the removal once.

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

Names can be hierarchical (`a:b:c`). A project without a category takes its nearest parent's, and a project added from the editor is written with it. The older form, keywords only, still loads.

Hierarchy: a project named `a:b` is below `a`, and a keyword of `a` also matches `a:b`. The deepest matching project wins, as in Descriptions. So with `car` (keyword `car`) and `car:maintainance` (keyword `car:maintainance`), `car`, `car wash` and `car: wash` are all `car:maintainance`, and `car:maintainance` written out is that project too. With `car:a` (keyword `a`) and `car:b` (keyword `b`) below `car`, `car a` is `car:a`, because its own keyword matches at the same depth where `car:b` only matches through `car`. When several children inherit the keyword and none has it as its own (`car` with `car:a` and `car:b`), `car` is the parent itself. A project that is not in that line of descent and matches by its own keyword is still an error: `gym car` matches `gym` and `car:maintainance`, which are unrelated, so it is an error. `tests/fixtures/sample/projects.yml` is a categorised example.

Projects in the time entries that are not registered are added to the same file as comments, between two marker lines. Uncomment one to accept it, rename it if needed, and add a category. Each suggestion lists its keywords one per line. `make sync-projects` only adds: it never changes or removes a line, and skips a project whose name or keyword is already in the file.

```
make sync-projects DATA_DIR=data
```

Reports compute hours from the parser output in `DATA_DIR`. Projects are matched again against the database on each run, so edits apply at once. The Reports tab lists the skipped files and the uncategorised days: each skipped file name opens that day in the editor, each skipped line links to the editor at that line, and the Files to fix tab lists the files to fix (skipped, or with uncategorised entries, each with the entries and the reason) as links that open the day in the editor. The Reports tab opens on the daily period for this week; choosing another period sets the range to the current week, month, quarter, half or year.

```
make report DATA_DIR=data PERIOD=monthly
make report DATA_DIR=data PERIOD=weekly FROM=2026-11-01 TO=2026-11-30
make report DATA_DIR=data PROJECT=gym,client-b:review         # exact project names
make report DATA_DIR=data PREFIX=client-b                     # client-b and every client-b:...
make report DATA_DIR=data CATEGORY=professional
make report DATA_DIR=data FORMAT=json
```

`PERIOD` is `daily`, `weekly` (ISO weeks, Monday first), `monthly`, `quarterly`, `half` (calendar halves, January to June and July to December, shown as `2026-H1` and `2026-H2`) or `yearly`. Periods with no entries show as zero. Hours are counted for closed entries; open entries (no end time) are shown separately. The same command without make: `node dist/cli.js report DATA_DIR --db FILE ...`.

## Editor mobile

The Editor mobile tab edits one day from a phone. Each entry is a card with its start, end, task, project and length; the open entry has an accent edge. Tap a card to change it in a bottom sheet: the start time (typed, from the phone's time picker, or from the Now, -5, -10, -15, +5 and +15 shortcuts), the description, and the project (the day's most used projects, a search, or a new project added on the spot, which gets its parent's category). The sheet can also add an entry after the one being edited, or delete it with a second tap. Add entry adds at the end, starting where the last entry ends, or now when it is open. The date at the top opens the list of days and a way to start a new one; the arrows move to the older and newer day. The start time is checked before it is written (08:30, 830, 7.15, +10 and -5 are read; other text is refused with the accepted forms), a new project can be given a category in the sheet, and a tap beside the sheet asks before it drops typed text. Nothing is written until Save changes, and a file that changed meanwhile is refused with the same check as the Editor tab.

## Web editor

`make editor` opens a local editor for the `.md` day files in `EDITOR_DIR` (default `data`). It runs on `127.0.0.1` and only reads and writes `.md` files in that folder. The same page is the web app above, with the files on disk instead of in the browser.

- **Plain text:** the whole file, with no restrictions.
- **Entries:** a table with the start and end times worked out by the parser. Times, descriptions and projects are dropdowns with suggestions, and free text is still accepted. Choosing a project writes its first keyword, without a comma, at the end of the description after a comma (`wash dishes, kitchen`), or replaces the comma tag the description already has. A description that already gives the project is left alone. A project that is not in `projects.yml` yet is added there automatically, with its name as keyword; the file's existing text is kept. A reference such as `8` copies the description of the entry it points to, as in the parser, so choosing a project on it writes the copied text and the keyword into the line. You can also add an entry after another one, or delete one.

Save with the button or Ctrl+S. The previous version of a file is kept in `build/editor-backups` (in the web app: in the browser's backups, not shown). A save is refused if the file changed on disk since it was opened; use Reload to see the new version. A file that does not parse can still be saved, and the error is shown.

**Delete** (next to Reload) removes the open day file from the folder, and its `<day>.json` too when there is one. A confirmation names both files first. Both are kept in the same backup folder (in the web app: in the browser's backups), so a deleted day can be restored by copying its backup back. A delete is refused if the file changed on disk since it was opened, as a save is; use Reload to see the new version. After a delete the editor shows the next day file (or none), and the viewer's day list no longer has the day. Sync carries the deletion to GitHub: a day deleted on this device is deleted in the data repository and does not come back on the next sync, and a deletion made on another device removes the day here, keeping its text as a backup. A day that was changed on GitHub after this device last synced is fetched again rather than deleted.

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

A file whose JSON was made from the same input, the same projects, the same parser version and the same year is skipped and reported as unchanged. `FORCE=1` (`--force`) parses every file again:

```
make import FORCE=1
```

The JSON has the parser output, and next to `original_text` these fields, so it can be read without the project database:

- `projects_text`: the project database used, as YAML text.
- `projects_source`: `projects.yml` for a live file, or the snapshot name for a frozen one.
- `projects_sha256` and `input_sha256`: SHA-256 of the projects text and of the day file's text.
- `frozen`: `true` for a frozen file.
- `year`: the year used for a header without one (`--year`, the freeze line's year, or the clock). A live file's JSON is parsed again when this changes.

## Frozen day files

A day file is live until it is frozen. A live file is parsed as above: its projects come from `projects.yml`, and a header without a year takes the year from `--year` or the clock. A frozen file is parsed from what its freeze line records, so parsing it again gives the same result, except `parsed_at`, whatever the clock and `projects.yml` say later.

Freezing is explicit. Nothing freezes a file on save or on import.

```
make freeze FILE=data/11-11.md                          # freeze one file
make freeze FROM=2026-11-01 TO=2026-11-30 DATA_DIR=data  # freeze the days in a range
make freeze FILE=data/11-11.md UNFREEZE=1                # remove the freeze line
make reparse-check DATA_DIR=data                         # parse the frozen files again, list what changed
```

Freezing writes a line right after the header (in an HTML page, just before the list):

```
#toggl 11/11
# frozen: year=2026 projects=2026-11-26T10_21_02
- [ ] 0800 gym
```

In an HTML page it is `<!-- frozen: year=2026 projects=2026-11-26T10_21_02 -->`. `# frozen:` is reserved: the parser skips that line and reads no entry from it. Freezing a frozen file again replaces the line with the current snapshot, so it picks up keywords added since, and the year stays the one already recorded. Freezing adds a line, so the entries below the header move down one line in the output's `line` numbers.

**Snapshots.** `projects=` names a snapshot of the project database, `data/projects-snapshots/YYYY-MM-DDTHH_MM_SS.yml` (the local time, to the second), next to `projects.yml`. Freezing writes a new snapshot only when `projects.yml` differs from the newest one; otherwise it reuses that one. The tools never change or delete a snapshot. A frozen file whose snapshot is missing is an error that names the file and the snapshot. Keep `data/projects-snapshots` with the day files, since a frozen file cannot be parsed without it.

**Reports.** An entry from a frozen file is matched with the projects recorded in its JSON, so a keyword added later does not move it. An entry from a live file is matched with the current `projects.yml`, as before, so adding a keyword still categorises the days that are not frozen.

**Parser upgrades.** A frozen file is parsed with the parser that makes its JSON. After a parser change, `make reparse-check` parses every frozen file in `DATA_DIR` again with the current parser and lists each entry or field that differs from its JSON. It also reports a snapshot whose sha256 no longer matches the `projects_sha256` in the JSON. It exits with status 1 when it finds either, and writes nothing.

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
- **Reports:** the reports panel, the browser version of `make report`. It opens on this week. Choose the period (day, week, month, quarter, half or year), a range (this or last week, month, quarter, half or year, or last year, which fill the dates; or custom), projects and prefixes (picked from a dropdown or typed), and category. The Previous and Next buttons beside From and To move both dates by one period (with half, by six months). Basic configurations, in a folded section, set a range and a category in one click: Work this week and Work last week set the category to professional. Project distribution shows the share of tracked time per project for the selected data, as the viewer does. Below it, the project and task breakdown lists each project with its tasks, for the selected range, as the Week view does: a parent project's time is the total of itself and its sub-projects (`a` is `a:1` plus `a:2`), with the sub-projects indented under it, and the arrow opens a project to show its sub-projects and tasks. A sunburst chart draws the same times: the inner ring is the top-level projects, the outer rings their sub-projects, and the size of an arc is its time. Clicking a slice that has sub-projects zooms the chart into it; All, Up or a click on the centre goes back. A label too long for its slice is shortened, and hovering a slice shows its full name and time. Its numbers match `node dist/cli.js report`, and the tests check both against the same fixtures.
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
