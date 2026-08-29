import {
  type EnclosingScope,
  type Query,
  type Report,
  type ResolvedSymbol,
  type SymbolInfo,
  type WhatRefs,
} from "@code-question-agent/core";
import { REQUEST_QUERY, type QueryRequest } from "@code-question-agent/daemon";
import { type MessageConnection } from "vscode-jsonrpc/node";
import { type CliOptions } from "./args.ts";

/** Maps `CliOptions` onto a `packages/core` `Query` — a regexp search or an exact symbol lookup. */
export function buildQuery(opts: CliOptions): Query {
  if (opts.regexp) {
    return {
      type: "search-query",
      query: opts.query,
      useRegExp: true,
      fileInclude: opts.fileInclude,
      fileExclude: opts.fileExclude,
    };
  }
  return {
    type: "symbol-query",
    symbol: opts.query,
    file: opts.file,
    line: opts.line,
    col: opts.col,
    fileInclude: opts.fileInclude,
    fileExclude: opts.fileExclude,
  };
}

export interface QueryResult {
  report: SymbolInfo | WhatRefs;
  /** Keyed by `ResolvedSymbol.id` — populated only when `--include-class-trace` was passed. */
  traces: Map<number, EnclosingScope>;
}

export function resolvedSymbolsOf(report: SymbolInfo | WhatRefs): ResolvedSymbol[] {
  return report.type === "what-refs" ? [report.symbol] : report.symbols;
}

async function fetchTrace(
  connection: MessageConnection,
  symbol: ResolvedSymbol,
): Promise<EnclosingScope> {
  const request: QueryRequest = {
    report: "enclosing-scope",
    query: {
      type: "symbol-query",
      symbol: symbol.name,
      file: symbol.file,
      line: symbol.line,
      col: symbol.col,
    },
  };
  return connection.sendRequest<EnclosingScope>(REQUEST_QUERY, request);
}

/** Sends the primary query, then one `enclosing-scope` follow-up per resolved symbol when `--include-class-trace` was passed. */
export async function runQuery(
  connection: MessageConnection,
  opts: CliOptions,
): Promise<QueryResult> {
  const request: QueryRequest = {
    query: buildQuery(opts),
    report: opts.whatRefs ? "what-refs" : "symbol-info",
  };
  const report = (await connection.sendRequest<Report>(REQUEST_QUERY, request)) as
    | SymbolInfo
    | WhatRefs;

  const traces = new Map<number, EnclosingScope>();
  if (opts.includeClassTrace) {
    for (const symbol of resolvedSymbolsOf(report)) {
      traces.set(symbol.id, await fetchTrace(connection, symbol));
    }
  }

  return { report, traces };
}
