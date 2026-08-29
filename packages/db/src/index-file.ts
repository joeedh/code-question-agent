import { type DocumentSymbol, type Location } from "vscode-languageserver-protocol/node";
import { type Kysely } from "kysely";
import { type Database, type OccurrenceKind } from "./schema.ts";

export interface SymbolNode {
  file: string;
  kind: string;
  name: string;
  def_line: number;
  def_col: number;
  def_end_line: number;
  def_end_col: number;
  /** Index into the same flat list, or `null` at the root. */
  parentIndex: number | null;
}

/**
 * Flattens a hierarchical `textDocument/documentSymbol` response (`hierarchicalDocumentSymbolSupport`,
 * per `packages/lsp-bridge/src/client.ts`'s `initialize` capabilities) into the flat row shape
 * `symbols` stores, keeping each node's parent as an index into the same list so
 * {@link replaceFileIndex} can turn it into `contains` edges once real row ids exist.
 */
export function mapDocumentSymbolsToRows(file: string, symbols: DocumentSymbol[]): SymbolNode[] {
  const rows: SymbolNode[] = [];

  function visit(symbol: DocumentSymbol, parentIndex: number | null): void {
    const index = rows.length;
    rows.push({
      file,
      kind: String(symbol.kind),
      name: symbol.name,
      def_line: symbol.selectionRange.start.line,
      def_col: symbol.selectionRange.start.character,
      def_end_line: symbol.selectionRange.end.line,
      def_end_col: symbol.selectionRange.end.character,
      parentIndex,
    });
    for (const child of symbol.children ?? []) {
      visit(child, index);
    }
  }

  for (const symbol of symbols) {
    visit(symbol, null);
  }
  return rows;
}

export interface OccurrenceInput {
  symbol_id: number;
  file: string;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  kind: OccurrenceKind;
}

/**
 * A `textDocument/references` result answers "where is this symbol used", so the caller
 * already knows which symbol the hits belong to — the definition position it queried from.
 */
export function mapReferencesToOccurrences(
  symbolId: number,
  locations: Location[],
  classifyKind: (location: Location) => OccurrenceKind,
): OccurrenceInput[] {
  return locations.map((location) => ({
    symbol_id: symbolId,
    file: location.uri,
    line: location.range.start.line,
    col: location.range.start.character,
    end_line: location.range.end.line,
    end_col: location.range.end.character,
    kind: classifyKind(location),
  }));
}

/**
 * Distinguishes a call site from a plain read by looking at what follows the reference in its
 * source line — `(`, skipping whitespace — since neither `references` nor `documentSymbol`
 * reports this directly.
 */
export function classifyOccurrenceKind(lineText: string, endCol: number): OccurrenceKind {
  const rest = lineText.slice(endCol);
  return /^\s*\(/.test(rest) ? "call" : "read";
}

export interface FileIndex {
  symbols: SymbolNode[];
  occurrences: OccurrenceInput[];
}

/**
 * Replaces everything `file` previously contributed — its `symbols`, the `contains` edges
 * between them, and any `occurrences` rows filed under it — inside one transaction, so a
 * concurrent reader never observes a half-updated file.
 */
export async function replaceFileIndex(
  db: Kysely<Database>,
  file: string,
  index: FileIndex,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("symbols")
      .select("id")
      .where("file", "=", file)
      .execute();
    const existingIds = existing.map((row) => row.id);
    if (existingIds.length > 0) {
      await trx.deleteFrom("edges").where("from_id", "in", existingIds).execute();
      await trx.deleteFrom("edges").where("to_id", "in", existingIds).execute();
      await trx.deleteFrom("occurrences").where("symbol_id", "in", existingIds).execute();
    }
    await trx.deleteFrom("occurrences").where("file", "=", file).execute();
    await trx.deleteFrom("symbols").where("file", "=", file).execute();

    const insertedIds: number[] = [];
    for (const node of index.symbols) {
      const { id } = await trx
        .insertInto("symbols")
        .values({
          file: node.file,
          kind: node.kind,
          name: node.name,
          def_line: node.def_line,
          def_col: node.def_col,
          def_end_line: node.def_end_line,
          def_end_col: node.def_end_col,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      insertedIds.push(id);
    }

    const edgeRows = index.symbols.flatMap((node, childIndex) => {
      if (node.parentIndex === null) return [];
      const fromId = insertedIds[node.parentIndex];
      const toId = insertedIds[childIndex];
      if (fromId === undefined || toId === undefined) return [];
      return [{ from_id: fromId, to_id: toId, kind: "contains" as const }];
    });
    if (edgeRows.length > 0) {
      await trx.insertInto("edges").values(edgeRows).execute();
    }

    if (index.occurrences.length > 0) {
      await trx.insertInto("occurrences").values(index.occurrences).execute();
    }
  });
}
