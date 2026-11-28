.DEFAULT_GOAL := help
.PHONY: help install check build cli test run e2e site serve icons samples check-samples view import freeze reparse-check report sync-projects viewer-build editor clean notes-clone notes-sync notes-select notes-import-review-commit notes-keep-local notes-take-incoming

FILE ?= tests/fixtures/sample/day.md
PROJECTS ?= data/projects.yml
ARGS ?=
YEAR ?= $(shell date +%Y)
JSON ?= tests/fixtures/sample/expected/week-day.json
VIEW ?= all

IN_DIR ?= data
FORCE ?=
UNFREEZE ?=
OUT_DIR ?= $(IN_DIR)
PATTERN ?=

DATA_DIR ?= data/in/latest
DB ?= data/projects.yml
PERIOD ?= monthly
FROM ?=
TO ?=
PROJECT ?=
PREFIX ?=
CATEGORY ?=
FORMAT ?= text


EDITOR_PORT ?= 8001
EDITOR_DIR ?= data/
EDITOR_URL = http://127.0.0.1:$(EDITOR_PORT)/

NODE = node dist/cli.js

NOTES_EXPORTER ?= $(HOME)/Documents/project/export-apple-notes/notes-exporter
NOTES_EXPORTER_REPO ?= https://github.com/storizzi/notes-exporter.git
STAMP := $(shell date +%Y-%m-%d-%H_%M_%S)
# notes-select makes a new folder and points data/in/latest at it; the review step uses that link.
NEW_IMPORT_DIR ?= data/in/$(STAMP)
# Folder choices for notes-select, e.g. NOTES_SELECT_ARGS='--exclude Work --include Work/Projects'.
NOTES_SELECT_ARGS ?=
# The ledger of imported Apple Notes notes (see docs/notes-import.md).
LEDGER ?= data/in/imports.json
IMPORT_DIR ?= data/

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install the npm packages
	npm install

check: ## Type-check the TypeScript
	npm run check

build: ## Build the CLI, the editor page and the installable web app (site/)
	npm run build

cli: ## Build dist/cli.js
	npm run build:cli

test: ## Run the test suite
	npm test

site: ## Build the installable web app into site/
	npm run build:site

serve: site ## Serve site/ at http://127.0.0.1:4173/time-tracker/ (the GitHub Pages layout)
	node scripts/serve-site.mjs 4173

e2e: build ## Browser tests of site/ (Chromium; WebKit too when its browser is installed)
	npx playwright test

icons: ## Regenerate the PNG icons in viewer/web/icons
	npm run build:icons

run: cli ## Parse FILE to JSON (PROJECTS when it exists; extra flags via ARGS)
	$(NODE) parse $(FILE) $(if $(wildcard $(PROJECTS)),--projects $(PROJECTS)) --year $(YEAR) $(ARGS) > $(FILE).json

samples: cli ## Parse every sample day in tests/fixtures/sample, and check the conflicting projects file is rejected
	@for day in tests/fixtures/sample/*.md; do echo "== $$day"; $(NODE) parse $$day --year $(YEAR) >/dev/null && echo "ok"; done
	@if $(NODE) parse tests/fixtures/sample/day.md --projects tests/fixtures/sample/projects-conflict.yaml --year $(YEAR) >/dev/null 2>&1; then echo "conflict file was accepted"; exit 1; else echo "conflict file rejected, as intended"; fi

check-samples: ## Compare each sample's output with tests/fixtures/sample/expected/*.json
	npm run test:build
	node --test --test-name-pattern="expected" dist-test/*.test.js

view: cli ## Show a parser output JSON as text (JSON=path, VIEW=all|entries|projects)
	$(NODE) view $(JSON) --view $(VIEW)

import: cli ## Convert every IN_DIR/*.md and *.html to OUT_DIR/<name>.json (PROJECTS and YEAR apply; PATTERN overrides the files; unchanged files are skipped, FORCE=1 parses all)
	$(NODE) convert $(IN_DIR) $(OUT_DIR) $(if $(PATTERN),--pattern "$(PATTERN)") --year $(YEAR) $(if $(wildcard $(PROJECTS)),--projects $(PROJECTS)) $(if $(FORCE),--force)

freeze: cli ## Freeze FILE, or every day in DATA_DIR from FROM to TO (DB: project database; UNFREEZE=1 removes the freeze line)
	@if [ -z "$(FROM)" ] && [ "$(origin FILE)" = "file" ]; then echo "make freeze needs FILE=... or FROM=... TO=... (with DATA_DIR)"; exit 1; fi
	$(NODE) freeze $(if $(FROM),,$(FILE)) --db $(DB) $(if $(FROM),--from $(FROM) --to $(TO) --dir $(DATA_DIR)) $(if $(UNFREEZE),--unfreeze)

reparse-check: cli ## Parse the frozen files in DATA_DIR again with this parser; list what changed and flag a snapshot that no longer matches (exit 1 when so)
	$(NODE) reparse-check $(DATA_DIR) --db $(DB)

notes-clone: ## Clone Notes Exporter into NOTES_EXPORTER when it is not there yet
	@test -d $(NOTES_EXPORTER) || git clone $(NOTES_EXPORTER_REPO) $(NOTES_EXPORTER)

notes-sync: notes-clone ## Export Apple Notes to Markdown with Notes Exporter (macOS only; same as zsh exportnotes.zsh -m)
	cd $(NOTES_EXPORTER) && source .venv/bin/activate && zsh $(NOTES_EXPORTER)/exportnotes.zsh -m

notes-select: ## Select the Toggl notes of the export into NEW_IMPORT_DIR and write its delete.sh (nothing is deleted yet)
	node scripts/notes-import.mjs select --out $(NEW_IMPORT_DIR) $(NOTES_SELECT_ARGS)
	@echo "Next: make notes-import-review-commit IMPORT_DIR=$(NEW_IMPORT_DIR)"
	@echo "Then, if the import is accepted: bash $(NEW_IMPORT_DIR)/delete.sh"

save: ## Commit data/ locally; saves only, pushes nothing
	cd data; git add -f . ; git diff --cached --quiet || git commit -m "Manual save of data/" 2>&1

sync: save ## Save, then push the current branch to GitLab (origin) and projects.yml to the GitHub data repository; exits non-zero if either fails
	@branch=$$(git rev-parse --abbrev-ref HEAD); st=0; \
	if git push origin "$$branch"; then echo "gitlab: pushed $$branch to origin"; else echo "gitlab: push of $$branch to origin FAILED (no force used)"; st=1; fi; \
	if node scripts/sync-projects-github.mjs $(DB); then :; else echo "github: sync FAILED"; st=1; fi; \
	exit $$st

sync-projects-github: ## Copy DB (projects.yml) to the GitHub data repository only; refuses to delete projects there
	node scripts/sync-projects-github.mjs $(DB)
.PHONY: save sync sync-projects-github

notes-import-review-commit: cli ## Import the selected notes in IMPORT_DIR (data/in/latest by default), write REPORT.txt, and commit
	@echo "" > errors.txt
	@test -e $(IMPORT_DIR) || (echo "no $(IMPORT_DIR); run make notes-select first" && exit 1)
	$(MAKE) -s import IN_DIR=$(IMPORT_DIR) OUT_DIR=$(IMPORT_DIR) PROJECTS=$(DB) 2>&1 | tee -a errors.txt
	node scripts/notes-import.mjs review --out $(IMPORT_DIR) 2>&1 | tee -a errors.txt
	@dir=$$(readlink -f $(IMPORT_DIR)); cd data; git add -f . ; git diff --cached --quiet || git commit -m "Import Toggl notes from $$(basename $$dir), and rest of files" 2>&1 | tee -a errors.txt
	@echo "Errors have been captured to errors.txt. nvim errors.txt + vsp gf to files"
	@echo "make sync-projects - add missing projects, then nvim $(DB)"

notes-keep-local: ## Keep the local copy of a note that changed in Apple Notes (FILE=the local copy; the Apple version is dropped)
	node scripts/notes-import.mjs keep-local --ledger $(LEDGER) --file "$(FILE)"

notes-take-incoming: ## Replace the local copy with the changed Apple Notes version (FILE=the local copy; the edited copy goes to replaced/)
	node scripts/notes-import.mjs take-incoming --ledger $(LEDGER) --file "$(FILE)"

report: cli ## Hours report from DATA_DIR (DB, PERIOD=daily|weekly|monthly|quarterly|half|yearly, FROM, TO, PROJECT, PREFIX, CATEGORY, FORMAT=text|json)
	$(NODE) report $(DATA_DIR) --db $(DB) --period $(PERIOD) $(if $(FROM),--from $(FROM)) $(if $(TO),--to $(TO)) $(if $(PROJECT),--project "$(PROJECT)") $(if $(PREFIX),--prefix "$(PREFIX)") $(if $(CATEGORY),--category $(CATEGORY)) --format $(FORMAT)

sync-projects: cli ## Add projects found in DATA_DIR but not in DB to DB, as comments to accept
	$(NODE) suggest $(DATA_DIR) --db $(DB)

viewer-build: ## Build the page the editor serves (viewer/dist/app.js)
	npm run build:viewer

editor: build ## Open the web editor for the .md files in EDITOR_DIR (DB=project database; Ctrl-C to stop)
	@(sleep 1; if command -v xdg-open >/dev/null; then xdg-open $(EDITOR_URL) 2>/dev/null; elif command -v open >/dev/null; then open $(EDITOR_URL); else false; fi) || echo "Open $(EDITOR_URL) in a browser" &
	$(NODE) editor $(EDITOR_DIR) $(if $(wildcard $(DB)),--db $(DB)) --port $(EDITOR_PORT)

clean: ## Remove build output and caches
	rm -rf dist dist-test build viewer/dist site playwright-report test-results

