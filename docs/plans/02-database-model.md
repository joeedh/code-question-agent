# Plan 2: Database Model

Companion docs: `docs/research/query-patterns-and-db-requirements.md` (schema derivation),
`docs/initialDesign.md` (storage/caching model), `docs/plans/01-build-system-and-lsp-bridge.md`
(prerequisite, verified complete — install/build/lint/test all pass, `packages/lsp-bridge`
answers `definition`/`references`/`hover`/`documentSymbol` against the real server).

## Context

`initialTaskList.md` scopes plan 2 as: using what the LSP bridge actually returns, design the
concrete database model — schema, storage backend choice, and the cache-identity/checkpoint
scheme from `initialDesign.md`. The research doc already did the analysis and proposed a
schema; what's left is to resolve the open questions it flagged and turn the design into a
real, tested package, the way plan 1 turned the LSP spec into a tested bridge rather than just
a design note.

This plan resolves the four open questions and defines the new package's scope.

## Decisions

**SQLite over DuckDB.** `initialDesign.md` already leaned this way; the write pattern settles
it. The daemon (plan 3) does frequent small transactional writes as the file watcher fires —
SQLite's strength — not bulk/analytical loads. `better-sqlite3` + Kysely is the path the
research doc already scoped (`withRecursive`, a registered `REGEXP` function, WAL mode).
`better-sqlite3` ships prebuilt binaries for the common platforms; no local native-build
toolchain needed for this package specifically (unlike the plan-5 NAPI watcher).

**`casts-to` is computed at query time, not stored as an edge.** The LSP spec has no
assignability request — `textDocument/*` gives definitions, references, hover, and document
symbols, not "is type A assignable to type B." Storing a derived `casts-to` edge would need
that answer computed against the compiler API directly, which is exactly the "hand-rolled
protocol layer" plan 1 chose not to build. So the schema keeps only `extends`/`implements` as
stored edges, and the cast-compatible-types query is a recursive CTE over those two edge
kinds — this was already the research doc's fallback reading, now made the actual design.

**`occurrences.kind` stays `read | call`.** Nothing in `ideas.md` asks for `write`/assignment
tracking yet, and the column is a plain text field — adding a value later is not a migration
that touches existing rows. No schema change needed to leave this open.

**Checkpoint bookkeeping is filesystem-based, not a SQL table.** A checkpoint is a literal
file copy of a live DB (`initialDesign.md`), so self-describing beats a separate catalog:

- Checkpoint files are named by their tree hash directly:
  `<data-dir>/checkpoints/<tree-hash>.sqlite`. Listing the directory _is_ the catalog — no
  need to open every file to find candidates for the closest-match search.
- LRU eviction reads the filesystem's own mtime (touched on access) rather than a DB row, so
  reading a checkpoint to seed a cold start never requires a write into that checkpoint file.
- What _does_ need a table, inside every DB (live or checkpoint): `file_state(file,
content_hash, mtime, size)`. Its job isn't checkpoint diffing (that's `git diff
--name-status` between tree hashes, per `initialDesign.md`) — it's reconciliation: when the
  daemon (re)opens a live DB, the watcher hasn't been running while the process was down, so
  every indexed file's stored hash/mtime+size gets compared against disk to catch drift before
  the DB is trusted. This table is new relative to the research doc's schema; it's required by
  the "one live DB, kept current in real time" model actually working across daemon restarts.

## Schema (final for this plan)

```
symbols(id, file, kind, name, def_line, def_col, def_end_line, def_end_col)
edges(id, from_id, to_id, kind)              -- kind: contains | extends | implements
occurrences(id, symbol_id, file, line, col, end_line, end_col, kind)  -- kind: read | call
file_state(file PRIMARY KEY, content_hash, mtime, size)
```

Indexes: `symbols(file)`, `symbols(name)`, `edges(from_id)`, `edges(kind)`,
`occurrences(symbol_id)`, `occurrences(file)` — per the research doc, the columns the query
catalog actually filters/joins on. `file` columns use the canonical form
`packages/lsp-bridge/src/uri.ts`'s `toFileUri`/`fromFileUri` already normalizes to (per
`docs/debugging.md`'s note on drive-letter casing).

## New package: `@code-question-agent/db`

Mirrors `@code-question-agent/lsp-bridge`'s shape: `src/`, `test/` with fixtures, its own
`package.json`/`tsconfig.json` extending the root base, built by the existing
`scripts/build.mjs` (already generic over any `packages/*` with a `src/index.ts`).

- **`src/schema.ts`** declares the Kysely `Database` interface for the four tables above.
- **`src/migrations/`** + **`src/migrate.ts`** — hand-written migrations via Kysely's
  `Migrator`/`FileMigrationProvider`, per the research doc's call on this (schema is small,
  not expected to churn).
- **`src/open.ts`** — opens a `better-sqlite3` connection for a given file path, registers the
  `REGEXP` function, sets WAL mode, wraps it in Kysely, runs pending migrations. One function
  for both a live DB and a checkpoint file — they're the same schema.
- **`src/index-file.ts`** — pure mapping functions from `lsp-bridge`'s response shapes
  (`DocumentSymbol[]`, `Location[]`/`LocationLink[]`) to row shapes for `symbols`/`edges`/
  `occurrences`, plus a per-file replace-in-one-transaction function (delete existing rows for
  a `file`, insert the new set). Testable against plan 1's existing fixtures
  (`packages/lsp-bridge/test/fixtures/basic`) without a live daemon loop — driving the LSP
  bridge to call these functions during a real watch loop is plan 3's job, not this one.
- **`src/checkpoint.ts`** — cache-identity logic: `git rev-parse HEAD^{tree}` for the base
  identity (working-tree changes are an overlay per `initialDesign.md`, not baked into a new
  hash), submodule-drift detection (on-disk submodule `HEAD` vs. the parent's recorded gitlink
  from `git ls-tree`), and closest-checkpoint search (list `checkpoints/*.sqlite`, rank
  candidates by `git diff --name-status --find-renames <candidate> <target>` file-change
  count). Shells out to `git` directly via `node:child_process`, matching how `lsp-bridge`
  spawns `tsc.exe` directly rather than pulling in a git library.
- **`src/reconcile.ts`** — the `file_state` comparison used at live-DB open: for every row,
  stat the file on disk and compare `mtime`+`size` first (cheap), falling back to a content
  hash only on a mismatch, to find files that changed while the daemon wasn't running.

## Dependencies

Add to `packages/db/package.json`: `kysely`, `better-sqlite3` (+ `@types/better-sqlite3` as a
dev dependency). `better-sqlite3` needs a native build step at install time — add it to
`onlyBuiltDependencies` in `pnpm-workspace.yaml` (already used for `esbuild`/`comment-lint`)
so `pnpm install` runs its build script.

## Tests

New `packages/db/test/`, following `lsp-bridge/test/lsp-bridge.test.ts`'s pattern of real
fixtures over mocks:

- Migration test: fresh temp file → migrate → expected tables/indexes exist.
- Mapping-function tests: feed real `documentSymbol`/`references` output captured from plan
  1's fixtures (or drive `lsp-bridge` live against them, gated the same way by `TSC_LSP_PATH`)
  through `index-file.ts`, assert the resulting rows.
- Per-file replace test: index a file, mutate the row set, re-index the same file, assert old
  rows are gone and new ones are present, inside one transaction.
- `checkpoint.ts` tests: a scratch git repo (temp dir, `git init`, a couple commits) — tree
  hash matches `git rev-parse`, closest-match ranking picks the smaller diff, a submodule
  checked out off its recorded gitlink is detected.
- `reconcile.ts` test: seed `file_state`, mutate a fixture file's content/mtime, assert it's
  flagged; assert an untouched file isn't.

## Done when

- `pnpm install`, `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test`
  all succeed from the repo root with `packages/db` included.
- The four tables above exist via migration, with the indexes listed.
- `index-file.ts`'s mapping functions produce correct rows against plan 1's real fixtures.
- `checkpoint.ts` computes a correct tree hash and closest-checkpoint ranking against a scratch
  git repo.
- Findings about `better-sqlite3`/Kysely/git-shelling behavior that were non-obvious land in
  `docs/debugging.md`.

## Open questions carried forward (not blocking, deferred to plan 3)

- Exact trigger points for taking a checkpoint (post-commit hook? post-checkout hook? idle
  heuristic?) — this is a daemon-lifecycle decision, not a schema one.
- How many candidates the closest-match search diffs before giving up, once the checkpoint set
  is large — a cap can be added later without a schema change.
