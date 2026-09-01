# DB package reference (`@code-question-agent/db`)

SQLite-backed storage: schema, migrations, per-file indexing from `lsp-bridge` response
shapes, and the cache-identity/checkpoint scheme. Uses Kysely + `better-sqlite3`.

See also: [`docs/daemon.md`](daemon.md) for how the daemon drives this package,
[`docs/plans/02-database-model.md`](plans/02-database-model.md) for the original design.

## Schema (`src/schema.ts`, `src/migrations/001_initial.ts`)

- **`symbols`** — one row per declaration.
  - `id` (autoincrement), `file` (a `file://` URI), `kind` (stringified LSP `SymbolKind`),
    `name`.
  - `def_line`/`def_col`/`def_end_line`/`def_end_col` — the declaration's selection range,
    0-indexed (LSP convention).
  - Indexed on `file` and `name`.
- **`edges`** — containment/inheritance relations between symbols.
  - `from_id`/`to_id` (both FK → `symbols.id`), `kind`: `"contains"` | `"extends"` |
    `"implements"`. Only `"contains"` is populated today (`replaceFileIndex`); `"extends"`/
    `"implements"` are reserved for a future class-hierarchy feature.
  - Indexed on `from_id` and `kind`.
- **`occurrences`** — one row per reference to a symbol.
  - `symbol_id` (FK → `symbols.id`), `file`, `line`/`col`/`end_line`/`end_col` (0-indexed),
    `kind`: `"read"` | `"call"`.
  - Indexed on `symbol_id` and `file`.
- **`file_state`** — one row per indexed file, the reconciliation cache.
  - `file` (primary key, a `file://` URI), `content_hash` (sha256 of file bytes),
    `mtime` (truncated `stat().mtimeMs`), `size`.
- Migrations run through Kysely's `Migrator` against a `StaticMigrationProvider` — a
  hand-written `Record<string, Migration>` rather than Kysely's `FileMigrationProvider`
  (which scans a real directory), because esbuild bundles this package's `dist/index.js`
  into a single file that doesn't carry `src/migrations/` along with it.

## Opening a database (`src/open.ts`)

- `openDatabase(filePath)` — opens (or creates) a SQLite file, sets `journal_mode = WAL`,
  registers a custom `regexp(pattern, value)` SQLite function, runs `migrateToLatest`, returns
  a `Kysely<Database>`. Used for both the live DB and a checkpoint file — same schema, same
  function.
  - The `regexp` function backs `SearchQuery.useRegExp` (`packages/core`) — SQLite's
    `x REGEXP y` operator has no built-in implementation and calls a function named `regexp`
    with the pattern first, the value second. Compiled `RegExp` objects are cached by pattern
    string so a repeated pattern isn't recompiled per row.
- `backupDatabase(sourcePath, destinationPath)` — copies a database via SQLite's online
  backup API, not a raw file copy. In WAL mode, recently-committed data can still live in the
  source's `-wal` file; a plain `fs.copyFile` of a live, open database can miss it. Opens its
  own short-lived read-only connection — WAL mode allows this to run alongside whatever
  connection already has `sourcePath` open.

## Per-file indexing (`src/index-file.ts`)

- `mapDocumentSymbolsToRows(file, symbols)` — flattens a hierarchical
  `textDocument/documentSymbol` response (`DocumentSymbol[]`, relying on
  `hierarchicalDocumentSymbolSupport`) into a flat `SymbolNode[]`, each carrying
  `parentIndex`: an index into the same array (`null` at the root) rather than a real row id,
  since no id exists until the row is inserted.
- `mapReferencesToOccurrences(symbolId, locations, classifyKind)` — maps a
  `textDocument/references` result onto `OccurrenceInput[]` for one symbol at a time; the
  caller already knows which symbol the hits belong to; it's the definition position that
  was queried from.
- `classifyOccurrenceKind(lineText, endCol)` — `"call"` if what follows the reference on its
  source line is `(` (optionally preceded by whitespace), else `"read"`. Neither `references`
  nor `documentSymbol` reports this directly, so it's inferred from source text.
- `replaceFileIndex(db, file, index)` — replaces everything a file previously contributed
  (its `symbols` rows, the `"contains"` edges between them, any `occurrences` filed under it)
  inside one transaction, so a concurrent reader never sees a half-updated file:
  1. Look up the file's existing `symbols.id`s.
  2. Delete edges referencing those ids (`from_id` or `to_id`), delete occurrences by
     `symbol_id`, delete occurrences by `file`, delete the `symbols` rows.
  3. Insert `index.symbols`, one at a time (`.returning("id")`) — a Kysely/SQLite constraint,
     `better-sqlite3` doesn't return multiple generated ids from a single batched insert.
  4. Build `"contains"` edge rows from each node's `parentIndex`, now resolved to real
     inserted ids; insert them.
  5. Insert `index.occurrences`.

## Reconciliation (`src/reconcile.ts`)

- Answers "what changed on disk while nothing was watching" — the daemon was down, or this
  is the first open of a checkpoint just promoted to a live DB. The watcher (`apps/daemon`)
  handles drift while it's running; this covers the gap before it starts.
- `computeQuickState(absolutePath)` — `{ mtime, size }` from one `stat()` call.
- `computeContentHash(absolutePath)` — sha256 of the file's full contents.
- `recordFileState(db, file)` — upserts a `file_state` row (`file` is the conflict key) with
  a freshly computed quick state and content hash. Called after a file is (re-)indexed.
- `reconcile(db)` → `{ changed: string[], removed: string[] }` — for every `file_state` row:
  1. `stat()` the file. If that fails, it's `removed`.
  2. If `mtime`/`size` still match the stored row, skip it — no further work.
  3. Otherwise, compute the content hash and compare against the stored one. Only a real hash
     mismatch counts as `changed` — a touch without an edit (mtime bumped, bytes identical)
     is not reported, since a content-hash computation is the expensive step and this quick
     check is what lets it be skipped for the common case.
- Callers (`apps/daemon`) re-index `changed` files and remove `removed` ones; neither list
  drives `file_state` itself — that stays `recordFileState`'s job, run again after
  re-indexing.

## Checkpoints (`src/checkpoint.ts`)

- A checkpoint is a snapshot of the live DB at a specific git commit's tree hash, stored as
  `<checkpointsDir>/<treeHash>.sqlite`.
- **Cache identity**: `getTreeHash(repoDir, ref = "HEAD")` — `git rev-parse <ref>^{tree}`. A
  tree hash already recursively encodes every submodule's pinned commit via its gitlink, so
  it's the whole cache key on its own. Uncommitted working-tree changes are a separate
  overlay (the live-DB file watcher), not folded into this hash.
- `listCheckpoints(checkpointsDir)` — every `<treeHash>.sqlite` file's basename; the
  directory listing is the catalog, there's no separate index. Returns `[]` if the directory
  doesn't exist yet.
- `checkpointPath(checkpointsDir, treeHash)` — the deterministic file path for a tree hash.
- `findClosestCheckpoint(repoDir, targetTreeHash, candidateTreeHashes)` — for each candidate,
  runs `git diff --name-status --find-renames <candidate> <target>` and counts changed lines;
  picks the smallest. A candidate two commits away with a small diff beats a one-commit-away
  candidate across a big refactor — the point is minimizing re-indexing work, not commit
  distance.
- `evictCheckpoints(checkpointsDir, budgetBytes, protectedTreeHashes)` — once the directory's
  total size exceeds `budgetBytes` (`DEFAULT_CHECKPOINT_BUDGET_BYTES` = 4 GiB), deletes
  checkpoints oldest-`mtime`-first until back under budget. Never deletes a tree hash in
  `protectedTreeHashes` (the daemon passes the tree hash it just captured, so a fresh
  checkpoint always survives its own eviction pass).
- `getSubmoduleDrift(repoDir)` — parses `git submodule status`; a `+`-prefixed line means the
  submodule's on-disk `HEAD` disagrees with the parent repo's recorded gitlink. Returns `[]`
  if the repo has no submodules or `git submodule status` fails. Exposed for a caller that
  wants to warn about or exclude drifted submodules; not consumed elsewhere in this package.

## Ownership boundaries

- This package never talks to `lsp-bridge` or spawns `tsc` — it consumes already-shaped
  `DocumentSymbol`/`Location` values and hands back rows.
- This package never talks to `chokidar` or decides _when_ to re-index — `apps/daemon`'s
  watcher decides that and calls `replaceFileIndex`/`recordFileState`.
- Tree-hash/checkpoint git operations shell out to `git` directly (`execFile`), the same
  "git is the single source of truth" choice `apps/daemon/src/watcher.ts` makes for ignore
  rules.
