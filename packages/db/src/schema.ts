import { type Generated } from "kysely";

export type SymbolKind = string;
export type EdgeKind = "contains" | "extends" | "implements";
export type OccurrenceKind = "read" | "call";

export interface SymbolsTable {
  id: Generated<number>;
  file: string;
  kind: SymbolKind;
  name: string;
  def_line: number;
  def_col: number;
  def_end_line: number;
  def_end_col: number;
}

export interface EdgesTable {
  id: Generated<number>;
  from_id: number;
  to_id: number;
  kind: EdgeKind;
}

export interface OccurrencesTable {
  id: Generated<number>;
  symbol_id: number;
  file: string;
  line: number;
  col: number;
  end_line: number;
  end_col: number;
  kind: OccurrenceKind;
}

export interface FileStateTable {
  file: string;
  content_hash: string;
  mtime: number;
  size: number;
}

export interface Database {
  symbols: SymbolsTable;
  edges: EdgesTable;
  occurrences: OccurrencesTable;
  file_state: FileStateTable;
}
