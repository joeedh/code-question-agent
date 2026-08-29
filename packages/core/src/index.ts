export interface Report<TYPE extends string = string> {
  type: TYPE;
  id: string;
  title: string;
  content: string;
}

export interface QueryBase<TYPE extends string = string> {
  type: TYPE;
  /** Regexp tested against the filesystem path of a matching symbol's declaring file (and, for `WhatRefs`, each reference's own file); kept only if it matches. */
  fileInclude?: string;
  /** Regexp tested against the filesystem path of a matching symbol's declaring file (and, for `WhatRefs`, each reference's own file); dropped if it matches. */
  fileExclude?: string;
}

export interface SymbolQuery extends QueryBase<"symbol-query"> {
  symbol: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface SearchQuery extends QueryBase<"search-query"> {
  query: string;
  useRegExp?: boolean;
}

export type Query = SymbolQuery | SearchQuery;

export interface Location {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface ResolvedSymbol extends Location {
  id: number;
  name: string;
  kind: string;
}

export interface Occurrence extends Location {
  kind: "read" | "call";
}

export interface SymbolInfo extends Report<"symbol-info"> {
  query: Query;
  info: string;
  symbols: ResolvedSymbol[];
}

export interface WhatRefs extends Report<"what-refs"> {
  query: Query;
  symbol: ResolvedSymbol;
  references: Occurrence[];
}

/** The chain of enclosing named scopes from a symbol up to the script root, nearest first. */
export interface EnclosingScope extends Report<"enclosing-scope"> {
  query: Query;
  symbol: ResolvedSymbol;
  trace: ResolvedSymbol[];
}
