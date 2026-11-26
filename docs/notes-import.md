# Re-importing the same Toggl notes

`make notes-select` copies the Toggl notes of the Apple Notes export into a new folder,
`data/in/<stamp>/`. The same note is exported again whenever it changes in Apple Notes,
so the next import copies it again. Two problems follow:

- a note that did not change is imported twice, and the two days are duplicates;
- a note edited locally in an earlier folder (a project added in the editor, a line fixed)
  is not seen by the new copy, and copying over it would lose the edit.

## Design

The import keeps a **ledger**, `data/in/imports.json`, with one entry per Apple Notes note,
keyed by the Notes id (the `id` of the tracker record; records from before Notes Exporter 1.3.0
use `legacy:<tracker>/<n>`). An entry records:

- `file`: the local copy, relative to `data/in` (`<stamp>/<name>.md`);
- `importedHash`: the SHA-256 of the local copy as the import wrote it;
- `sourceHash`: the SHA-256 of the Apple Notes Markdown the copy came from;
- `pending`: set only while a conflict is open: the hash of the changed Apple Notes version and
  the file that holds it (`<stamp>/incoming/<name>.md`).

Each `select` compares the Apple Notes file with the ledger, and the local copy with
`importedHash`:

| Apple Notes changed since the last import? | Local copy edited since the last import? | Action |
|---|---|---|
| no | — | **unchanged**: nothing is copied, and its original is still deleted by `delete.sh` |
| yes | no (or the local copy is gone) | **updated**: copied into the new folder, and the ledger points there; the older copy is listed as superseded |
| yes | yes | **conflict**: the local copy is kept; the Apple version is written to `<stamp>/incoming/`; its original is not deleted |
| not in the ledger | — | **new**: copied, as before |

A local copy that was deleted counts as not imported, so the note is copied again.

## Resolving a conflict

The report lists each conflict with its local copy and its incoming version.

- `make notes-keep-local FILE=data/in/<stamp>/<name>.md`: keep the local edits. The ledger
  accepts the Apple Notes version as seen, so later selects leave the note alone. The incoming
  copy is removed.
- `make notes-take-incoming FILE=data/in/<stamp>/<name>.md`: take the Apple Notes version. The
  edited copy is moved to `data/in/<stamp>/replaced/` (not converted), so nothing is lost.

After either, run `make import IMPORT_DIR=...` to regenerate the JSON of that day.

## What this does not cover

- The JSON is generated from the Markdown, so an edit to the JSON alone is not tracked; edit the Markdown.
- A note moved to another account gets a new Notes id, so it is imported as new.
- Older copies of an updated note stay in their folders. The report lists them, so they can be removed.
