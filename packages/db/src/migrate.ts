import { type Kysely, type Migration, type MigrationProvider, Migrator } from "kysely";
import * as initial from "./migrations/001_initial.ts";
import { type Database } from "./schema.ts";

const migrations: Record<string, Migration> = {
  "001_initial": initial,
};

/**
 * Hands the migrator a fixed, statically-imported migration set instead of Kysely's
 * `FileMigrationProvider`, which scans a real directory on disk — a mismatch with this
 * package's `dist/index.js`, which esbuild bundles into a single file that doesn't carry
 * `src/migrations/` along with it.
 */
class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === "Error") {
      throw new Error(`migration ${result.migrationName} failed`);
    }
  }
  if (error) throw error;
}
