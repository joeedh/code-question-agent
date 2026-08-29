import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fromFileUri } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import { type Database } from "./schema.ts";

export interface QuickFileState {
  mtime: number;
  size: number;
}

export async function computeQuickState(absolutePath: string): Promise<QuickFileState> {
  const info = await stat(absolutePath);
  return { mtime: Math.trunc(info.mtimeMs), size: info.size };
}

export async function computeContentHash(absolutePath: string): Promise<string> {
  const data = await readFile(absolutePath);
  return createHash("sha256").update(data).digest("hex");
}

/** Records or updates a file's `file_state` row after it's been (re-)indexed. */
export async function recordFileState(db: Kysely<Database>, file: string): Promise<void> {
  const absolutePath = fromFileUri(file);
  const [quick, content_hash] = await Promise.all([
    computeQuickState(absolutePath),
    computeContentHash(absolutePath),
  ]);
  await db
    .insertInto("file_state")
    .values({ file, content_hash, mtime: quick.mtime, size: quick.size })
    .onConflict((oc) =>
      oc.column("file").doUpdateSet({ content_hash, mtime: quick.mtime, size: quick.size }),
    )
    .execute();
}

export interface ReconcileResult {
  /** Files whose stored content hash no longer matches what's on disk. */
  changed: string[];
  /** Files with a `file_state` row but no longer present on disk. */
  removed: string[];
}

/**
 * Catches drift the watcher couldn't have seen because it wasn't running — the daemon was
 * down, or this is the first open of a checkpoint promoted to a live DB. `mtime`/`size` is
 * checked first since it's a `stat` away; a content hash is only computed to confirm an actual
 * change (and rule out a touch-without-edit false positive) once that quick check disagrees.
 */
export async function reconcile(db: Kysely<Database>): Promise<ReconcileResult> {
  const rows = await db.selectFrom("file_state").selectAll().execute();
  const changed: string[] = [];
  const removed: string[] = [];

  for (const row of rows) {
    const absolutePath = fromFileUri(row.file);
    let quick: QuickFileState;
    try {
      quick = await computeQuickState(absolutePath);
    } catch {
      removed.push(row.file);
      continue;
    }
    if (quick.mtime === row.mtime && quick.size === row.size) continue;

    const contentHash = await computeContentHash(absolutePath);
    if (contentHash !== row.content_hash) {
      changed.push(row.file);
    }
  }

  return { changed, removed };
}
