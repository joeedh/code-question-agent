import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("symbols")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("file", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("def_line", "integer", (col) => col.notNull())
    .addColumn("def_col", "integer", (col) => col.notNull())
    .addColumn("def_end_line", "integer", (col) => col.notNull())
    .addColumn("def_end_col", "integer", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("symbols_file").on("symbols").column("file").execute();
  await db.schema.createIndex("symbols_name").on("symbols").column("name").execute();

  await db.schema
    .createTable("edges")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("from_id", "integer", (col) => col.notNull().references("symbols.id"))
    .addColumn("to_id", "integer", (col) => col.notNull().references("symbols.id"))
    .addColumn("kind", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("edges_from_id").on("edges").column("from_id").execute();
  await db.schema.createIndex("edges_kind").on("edges").column("kind").execute();

  await db.schema
    .createTable("occurrences")
    .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
    .addColumn("symbol_id", "integer", (col) => col.notNull().references("symbols.id"))
    .addColumn("file", "text", (col) => col.notNull())
    .addColumn("line", "integer", (col) => col.notNull())
    .addColumn("col", "integer", (col) => col.notNull())
    .addColumn("end_line", "integer", (col) => col.notNull())
    .addColumn("end_col", "integer", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("occurrences_symbol_id")
    .on("occurrences")
    .column("symbol_id")
    .execute();
  await db.schema.createIndex("occurrences_file").on("occurrences").column("file").execute();

  await db.schema
    .createTable("file_state")
    .addColumn("file", "text", (col) => col.primaryKey())
    .addColumn("content_hash", "text", (col) => col.notNull())
    .addColumn("mtime", "integer", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("file_state").execute();
  await db.schema.dropTable("occurrences").execute();
  await db.schema.dropTable("edges").execute();
  await db.schema.dropTable("symbols").execute();
}
