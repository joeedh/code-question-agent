import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, openDatabase } from "../src/open.ts";
import { type Database } from "../src/schema.ts";

describe("migrations", () => {
  let dir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-db-"));
    db = await openDatabase(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the four tables", async () => {
    const rows = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(
      db,
    );
    const names = rows.rows.map((row) => row.name).sort();
    expect(names).toEqual(
      [
        "edges",
        "file_state",
        "kysely_migration",
        "kysely_migration_lock",
        "occurrences",
        // SQLite creates this bookkeeping table itself for any AUTOINCREMENT column.
        "sqlite_sequence",
        "symbols",
      ].sort(),
    );
  });

  it("creates the expected indexes", async () => {
    const rows = await sql<{ name: string }>`select name from sqlite_master where type = 'index'`.execute(
      db,
    );
    const names = rows.rows.map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "symbols_file",
        "symbols_name",
        "edges_from_id",
        "edges_kind",
        "occurrences_symbol_id",
        "occurrences_file",
      ]),
    );
  });

  it("is idempotent — opening an already-migrated DB again is a no-op", async () => {
    const again = await openDatabase(path.join(dir, "test.sqlite"));
    const rows = await again.selectFrom("symbols").selectAll().execute();
    expect(rows).toEqual([]);
    await again.destroy();
  });

  it("registers a REGEXP function usable from SQL", async () => {
    await db
      .insertInto("symbols")
      .values({
        file: "file:///a.ts",
        kind: "12",
        name: "someRegexpTarget",
        def_line: 0,
        def_col: 0,
        def_end_line: 0,
        def_end_col: 10,
      })
      .execute();
    const matches = await db
      .selectFrom("symbols")
      .selectAll()
      .where(sql<boolean>`name REGEXP ${"^some_?[Rr]egexp"}`)
      .execute();
    expect(matches).toHaveLength(1);
  });

  it("backs up a live database to a new file, visible to a fresh connection", async () => {
    await db
      .insertInto("symbols")
      .values({
        file: "file:///a.ts",
        kind: "12",
        name: "backedUp",
        def_line: 0,
        def_col: 0,
        def_end_line: 0,
        def_end_col: 5,
      })
      .execute();

    const backupPath = path.join(dir, "backup.sqlite");
    await backupDatabase(path.join(dir, "test.sqlite"), backupPath);

    const restored = await openDatabase(backupPath);
    try {
      const rows = await restored.selectFrom("symbols").selectAll().execute();
      expect(rows.map((r) => r.name)).toEqual(["backedUp"]);
    } finally {
      await restored.destroy();
    }
  });
});
