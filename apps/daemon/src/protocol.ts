import { type Query } from "@code-question-agent/core";

/**
 * `Query` (`packages/core`) names what to look up, not which report shape to answer with —
 * that selection is a CLI-flag concern (`--what-refs`, `--include-class-trace`) plan 4 hasn't
 * built yet, so it lives here on the IPC request instead of on `Query` itself for now.
 */
export interface QueryRequest {
  query: Query;
  report: "symbol-info" | "what-refs" | "enclosing-scope";
}

export interface StatusResult {
  pid: number;
  repoRoot: string;
  startedAt: string;
  indexing: boolean;
  /** How many of the cold-start scan's files have been indexed so far. Absent until the scan's file list is known. */
  filesIndexed?: number;
  /** Total files the cold-start scan found. Absent until the scan's file list is known. */
  filesTotal?: number;
}

/** Written to `daemon.json` on startup — a hint for where to connect, never trusted on its own. */
export interface DaemonMetadata {
  pid: number;
  ipcAddress: string;
  startedAt: string;
}

export const REQUEST_STATUS = "status";
export const REQUEST_QUERY = "query";
export const REQUEST_SHUTDOWN = "shutdown";
