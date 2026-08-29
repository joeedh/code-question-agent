import SqliteDatabase from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { migrateToLatest } from "./migrate.ts";
import { type Database } from "./schema.ts";

/**
 * Opens a live DB or a checkpoint file — both use the same schema, so one function covers
 * both, per `docs/plans/02-database-model.md`.
 */
export async function openDatabase(filePath: string): Promise<Kysely<Database>> {
  const sqlite = new SqliteDatabase(filePath);
  sqlite.pragma("journal_mode = WAL");
  registerRegExp(sqlite);

  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  await migrateToLatest(db);
  return db;
}

/**
 * Copies `sourcePath` to `destinationPath` via SQLite's own online backup API rather than a
 * raw file copy — in WAL mode, recently-committed data can still live in the `-wal` file
 * alongside the main database file, so a plain `fs.copyFile` of a live, open database can miss
 * it. Opens its own short-lived read-only connection; WAL mode allows concurrent readers
 * alongside whatever connection is already using `sourcePath`.
 */
export async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const sqlite = new SqliteDatabase(sourcePath, { readonly: true });
  try {
    await sqlite.backup(destinationPath);
  } finally {
    sqlite.close();
  }
}

/**
 * `SearchQuery.useRegExp` (`packages/core`) has no equivalent built into SQLite, so a
 * `regexp(pattern, value)` function is registered by hand — SQLite's `x REGEXP y` operator
 * calls a function named `regexp` with the pattern first and the value second.
 */
function registerRegExp(sqlite: SqliteDatabase.Database): void {
  const compiled = new Map<string, RegExp>();
  sqlite.function("regexp", (pattern: unknown, value: unknown) => {
    if (typeof pattern !== "string" || typeof value !== "string") return 0;
    let re = compiled.get(pattern);
    if (!re) {
      re = new RegExp(pattern);
      compiled.set(pattern, re);
    }
    return re.test(value) ? 1 : 0;
  });
}
