// Two-way sync of the day files between this device and the private data repository.
//
// Each file keeps the hash it had at the last sync (local) and the blob sha it had on GitHub (remote).
// A side has changed when it differs from that. Changes are never lost:
//   - one side changed: that version is copied to the other side;
//   - both changed and the texts differ: the remote version becomes the file, and this device's
//     version is saved next to it as <name>.conflict-<device>-<stamp>.md, on both sides.
import { sha256Hex, fileStamp } from "./hash";
import type { RemoteEntry } from "./github";

export interface SyncedState {
  hash: string;
  sha: string;
}

// The local day files, as the sync needs them.
export interface SyncLocal {
  list(): Promise<{ name: string; hash: string }[]>;
  read(name: string): Promise<{ text: string }>;
  // Replaces a day file with text, but only while the file still reads as expectedText. The check and the
  // replacement are one step in the store, so an edit made meanwhile is never overwritten. Returns false
  // when the file changed. The previous version is kept by the store.
  write(name: string, text: string, expectedText: string): Promise<boolean>;
  create(name: string, text: string): Promise<void>;
  synced(): Promise<Map<string, SyncedState>>;
  setSynced(name: string, state: SyncedState): Promise<void>;
}

// The data repository, as the sync needs it (see githubRepo in github.ts).
export interface SyncRemote {
  list(): Promise<RemoteEntry[]>;
  get(name: string): Promise<{ text: string; sha: string }>;
  put(name: string, text: string, sha: string | null, message: string): Promise<{ sha: string }>;
}

export interface SyncOptions {
  device: string;
  now: Date;
}

export interface SyncOutcome {
  checked: number;
  pushed: string[];
  pulled: string[];
  conflicts: { name: string; copy: string }[];
  errors: { name: string; message: string }[];
}

// The name of the copy that keeps this device's version of a conflicting file.
export function conflictName(name: string, device: string, now: Date, taken: (name: string) => boolean): string {
  const base = name.replace(/\.md$/, "");
  const safeDevice = device.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "device";
  const stamp = fileStamp(now);
  let candidate = `${base}.conflict-${safeDevice}-${stamp}.md`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${base}.conflict-${safeDevice}-${stamp}-${n}.md`;
  return candidate;
}

export async function syncDays(local: SyncLocal, remote: SyncRemote, options: SyncOptions): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { checked: 0, pushed: [], pulled: [], conflicts: [], errors: [] };
  const localFiles = new Map((await local.list()).map((file) => [file.name, file]));
  const remoteFiles = new Map((await remote.list()).map((file) => [file.name, file]));
  const state = await local.synced();
  const names = [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort();
  const commit = (name: string) => `Sync ${name} from ${options.device}`;

  for (const name of names) {
    outcome.checked += 1;
    try {
      await syncOne(name);
    } catch (err) {
      outcome.errors.push({ name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcome;

  async function syncOne(name: string): Promise<void> {
    const mine = localFiles.get(name);
    const theirs = remoteFiles.get(name);
    const known = state.get(name);

    if (mine && !theirs) {
      const { text } = await local.read(name);
      const pushed = await remote.put(name, text, null, commit(name));
      await local.setSynced(name, { hash: await sha256Hex(text), sha: pushed.sha });
      outcome.pushed.push(name);
      return;
    }
    if (!mine && theirs) {
      const file = await remote.get(name);
      await local.create(name, file.text);
      await local.setSynced(name, { hash: await sha256Hex(file.text), sha: file.sha });
      outcome.pulled.push(name);
      return;
    }
    if (!mine || !theirs) return;

    const localChanged = !known || mine.hash !== known.hash;
    const remoteChanged = !known || theirs.sha !== known.sha;
    if (!localChanged && !remoteChanged) return;

    if (localChanged && !remoteChanged) {
      const { text } = await local.read(name);
      const pushed = await remote.put(name, text, theirs.sha, commit(name));
      await local.setSynced(name, { hash: await sha256Hex(text), sha: pushed.sha });
      outcome.pushed.push(name);
      return;
    }

    // The remote changed. Read the file on this device again after the download: an edit saved during
    // the sync counts as a change on this side too.
    const file = await remote.get(name);
    const remoteHash = await sha256Hex(file.text);
    const current = (await local.read(name)).text;
    const currentHash = await sha256Hex(current);
    if (remoteHash === currentHash) {
      await local.setSynced(name, { hash: currentHash, sha: file.sha });
      return;
    }
    const changedHere = localChanged || currentHash !== mine.hash;
    if (!changedHere && (await local.write(name, file.text, current))) {
      await local.setSynced(name, { hash: remoteHash, sha: file.sha });
      outcome.pulled.push(name);
      return;
    }

    // Both sides changed: keep the remote version as the file and this device's newest version as a copy.
    const latest = (await local.read(name)).text;
    const copy = conflictName(name, options.device, options.now, (candidate) => localFiles.has(candidate) || remoteFiles.has(candidate));
    await local.create(copy, latest);
    if (!(await local.write(name, file.text, latest))) {
      throw new Error("the file changed again during the sync; the next sync will pick it up");
    }
    await local.setSynced(name, { hash: remoteHash, sha: file.sha });
    const copied = await remote.put(copy, latest, null, commit(copy));
    await local.setSynced(copy, { hash: await sha256Hex(latest), sha: copied.sha });
    localFiles.set(copy, { name: copy, hash: await sha256Hex(latest) });
    remoteFiles.set(copy, { name: copy, sha: copied.sha });
    outcome.conflicts.push({ name, copy });
  }
}
