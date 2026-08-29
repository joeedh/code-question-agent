export {
  checkpointPath,
  DEFAULT_CHECKPOINT_BUDGET_BYTES,
  evictCheckpoints,
  findClosestCheckpoint,
  getSubmoduleDrift,
  getTreeHash,
  listCheckpoints,
  type SubmoduleDrift,
} from "./checkpoint.ts";
export {
  classifyOccurrenceKind,
  type FileIndex,
  mapDocumentSymbolsToRows,
  mapReferencesToOccurrences,
  type OccurrenceInput,
  replaceFileIndex,
  type SymbolNode,
} from "./index-file.ts";
export { migrateToLatest } from "./migrate.ts";
export { backupDatabase, openDatabase } from "./open.ts";
export {
  computeContentHash,
  computeQuickState,
  type QuickFileState,
  reconcile,
  type ReconcileResult,
  recordFileState,
} from "./reconcile.ts";
export {
  type Database,
  type EdgeKind,
  type EdgesTable,
  type FileStateTable,
  type OccurrenceKind,
  type OccurrencesTable,
  type SymbolKind,
  type SymbolsTable,
} from "./schema.ts";
