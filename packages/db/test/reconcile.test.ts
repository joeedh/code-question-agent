import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toFileUri } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/open.ts";
import { recordFileState, reconcile } from "../src/reconcile.ts";
import { type Database } from "../src/schema.ts";

describe("reconcile", () => {
  let dir: string;
  let db: Kysely<Database>;
  let filePath: string;
  let fileUri: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-reconcile-"));
    db = await openDatabase(path.join(dir, "test.sqlite"));
    filePath = path.join(dir, "watched.ts");
    fileUri = toFileUri(filePath);
    await writeFile(filePath, "export const value = 1;\n");
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports nothing changed for a file recorded and left untouched", async () => {
    await recordFileState(db, fileUri);
    const result = await reconcile(db);
    expect(result).toEqual({ changed: [], removed: [] });
  });

  it("flags a file whose content changed while unwatched", async () => {
    await recordFileState(db, fileUri);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(filePath, "export const value = 2;\n");

    const result = await reconcile(db);
    expect(result.changed).toEqual([fileUri]);
    expect(result.removed).toEqual([]);
  });

  it("does not flag a touch that leaves content unchanged", async () => {
    await recordFileState(db, fileUri);
    // Rewrite with identical bytes: mtime/size can still differ from the stored row
    // depending on filesystem timestamp resolution, but content is the same.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(filePath, "export const value = 1;\n");

    const result = await reconcile(db);
    expect(result.changed).toEqual([]);
  });

  it("flags a file that was removed from disk", async () => {
    await recordFileState(db, fileUri);
    await rm(filePath);

    const result = await reconcile(db);
    expect(result.removed).toEqual([fileUri]);
    expect(result.changed).toEqual([]);
  });
});
