export interface Report<TYPE extends string = string> {
  type: TYPE
  id: string;
  title: string;
  content: string;
}

export interface QueryBase<TYPE extends string = string> {
    type: TYPE 
}

export interface SymbolQuery extends QueryBase<'symbol-query'> {
    symbol: string
    file?: string
    line?: number
    col?: number // column
}

export interface SearchQuery extends QueryBase<'search-query'> {
    query: string;
    useRegExp?: boolean
}

export type Query = SymbolQuery | SearchQuery

export interface SymbolInfo extends Report<'symbol-info'> {
    query: Query
    info: string;
}

export interface WhatRefs extends Report<'what-refs'> {
    query: Query
    references: SymbolInfo[];
}
