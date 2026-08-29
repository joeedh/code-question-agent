import { randomUUID } from "node:crypto";
import { type Database } from "@code-question-agent/db";
import { type Kysely, sql } from "kysely";
import type {
  EnclosingScope,
  Occurrence,
  Query,
  ResolvedSymbol,
  SearchQuery,
  SymbolInfo,
  SymbolQuery,
  WhatRefs,
} from "@code-question-agent/core";

function isSearchQuery(query: Query): query is SearchQuery {
  return query.type === "search-query";
}

interface SymbolRow {
  id: number;
  file: string;
  kind: string;
  name: string;
  def_line: number;
  def_col: number;
  def_end_line: number;
  def_end_col: number;
}

function toResolvedSymbol(row: SymbolRow): ResolvedSymbol {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    file: row.file,
    line: row.def_line,
    col: row.def_col,
    endLine: row.def_end_line,
    endCol: row.def_end_col,
  };
}

/**
 * Resolves a `Query` to the `symbols` rows it names. `SymbolQuery.line`/`.col`, when given,
 * are treated as the symbol's declaration position (what a prior `documentSymbol` scan would
 * have reported), the way a caller disambiguates between two same-named symbols.
 */
export async function resolveSymbols(db: Kysely<Database>, query: Query): Promise<ResolvedSymbol[]> {
  let builder = db.selectFrom("symbols").selectAll();

  if (isSearchQuery(query)) {
    builder = query.useRegExp
      ? builder.where(sql<boolean>`name REGEXP ${query.query}`)
      : builder.where("name", "=", query.query);
  } else {
    const symbolQuery: SymbolQuery = query;
    builder = builder.where("name", "=", symbolQuery.symbol);
    if (symbolQuery.file !== undefined) builder = builder.where("file", "=", symbolQuery.file);
    if (symbolQuery.line !== undefined) builder = builder.where("def_line", "=", symbolQuery.line);
    if (symbolQuery.col !== undefined) builder = builder.where("def_col", "=", symbolQuery.col);
  }

  const rows = await builder.execute();
  return rows.map(toResolvedSymbol);
}

function summarize(symbols: ResolvedSymbol[]): string {
  if (symbols.length === 0) return "no matching symbols";
  return symbols.map((s) => `${s.name} (${s.kind}) at ${s.file}:${s.line}:${s.col}`).join("\n");
}

export async function symbolLookup(db: Kysely<Database>, query: Query): Promise<SymbolInfo> {
  const symbols = await resolveSymbols(db, query);
  return {
    type: "symbol-info",
    id: randomUUID(),
    title: "Symbol lookup",
    content: summarize(symbols),
    query,
    info: summarize(symbols),
    symbols,
  };
}

async function resolveOneSymbol(db: Kysely<Database>, query: Query): Promise<ResolvedSymbol> {
  const symbols = await resolveSymbols(db, query);
  const symbol = symbols[0];
  if (!symbol) throw new Error("no symbol matched this query");
  return symbol;
}

export async function whatRefs(db: Kysely<Database>, query: Query): Promise<WhatRefs> {
  const symbol = await resolveOneSymbol(db, query);
  const rows = await db
    .selectFrom("occurrences")
    .selectAll()
    .where("symbol_id", "=", symbol.id)
    .execute();
  const references: Occurrence[] = rows.map((row) => ({
    file: row.file,
    line: row.line,
    col: row.col,
    endLine: row.end_line,
    endCol: row.end_col,
    kind: row.kind,
  }));

  return {
    type: "what-refs",
    id: randomUUID(),
    title: `References to ${symbol.name}`,
    content: references.map((r) => `${r.file}:${r.line}:${r.col} (${r.kind})`).join("\n"),
    query,
    symbol,
    references,
  };
}

interface TraceRow extends SymbolRow {
  depth: number;
}

/**
 * Walks `edges.kind = 'contains'` upward from `symbol`'s row — a recursive CTE over the
 * containment relation, the shape `docs/research/query-patterns-and-db-requirements.md`
 * flagged as the reason Kysely was chosen over Drizzle.
 */
export async function enclosingScope(db: Kysely<Database>, query: Query): Promise<EnclosingScope> {
  const symbol = await resolveOneSymbol(db, query);

  const result = await sql<TraceRow>`
    WITH RECURSIVE trace(id, file, kind, name, def_line, def_col, def_end_line, def_end_col, depth) AS (
      SELECT s.id, s.file, s.kind, s.name, s.def_line, s.def_col, s.def_end_line, s.def_end_col, 0
      FROM symbols s WHERE s.id = ${symbol.id}
      UNION ALL
      SELECT p.id, p.file, p.kind, p.name, p.def_line, p.def_col, p.def_end_line, p.def_end_col, t.depth + 1
      FROM trace t
      JOIN edges e ON e.to_id = t.id AND e.kind = 'contains'
      JOIN symbols p ON p.id = e.from_id
    )
    SELECT * FROM trace WHERE depth > 0 ORDER BY depth ASC
  `.execute(db);

  const trace = result.rows.map(toResolvedSymbol);
  return {
    type: "enclosing-scope",
    id: randomUUID(),
    title: `Enclosing scope of ${symbol.name}`,
    content: trace.length === 0 ? "(script root)" : trace.map((s) => s.name).join("."),
    query,
    symbol,
    trace,
  };
}
