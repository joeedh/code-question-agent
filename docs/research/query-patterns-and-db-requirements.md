# Query Patterns and Database Requirements

Research for plan 2 (the database model). Works out what the tool actually needs to ask the
database, using ideas.md's query surface and initialDesign.md's schema sketch as the starting
point, and packages/lsp-bridge's current capabilities (plus docs/debugging.md's findings on
the real TypeScript LSP server) as the ground truth for what data is available to store.

## Query catalog

Each entry is a query shape from ideas.md, what it needs from the database, and what that
implies the schema has to hold.

### Symbol lookup (`SymbolQuery` / `SearchQuery`)

Find a symbol by exact name, or every symbol matching a regexp, optionally narrowed to a file.
Needs an indexed lookup on `symbols.name` for the exact case, and a scan filtered by a regular
expression for the search case. SQLite has no built-in `REGEXP` operator; `better-sqlite3`
lets the caller register one as a custom SQL function, so `useRegExp` becomes
`WHERE name REGEXP ?` once that function is registered on the connection Kysely wraps. An
exact-name lookup should still go through an index rather than the same scan.

### What-refs

Every reference to a resolved symbol: file, position, and a snippet. This is the query that
motivates keeping references as their own rows rather than folding them into `symbols` — a
symbol has one definition, but references are wherever the symbol is used, an unbounded set
found through `textDocument/references`, and each occurrence needs its own position. See
"Schema implications" below.

### Enclosing scope / call trace (`--include-class-trace`)

For a hit at some position, the chain of enclosing named scopes up to the script root — the
"`inside SomeClass.Bleh.closure1`" line in ideas.md's example. This is a upward walk over a
lexical-containment relationship between symbols (an inner function contained by an outer
one, a method contained by a class), which is a natural fit for a recursive CTE over a
`contains` edge, terminating when a symbol has no containing parent.

### Cast-compatible types (`--search-castable-types`)

Find every type a value at a call site could satisfy — interfaces a class implements, base
types it extends — reported in ideas.md's example as a "possible function call" alongside the
direct one. This needs a type-hierarchy walk over `extends`/`implements` relationships between
symbols, in principle multiple hops deep (an interface extending another interface), so it's
the second recursive-CTE shape the schema has to support, distinct from the containment walk
above since it walks a different edge kind and in the opposite direction (up the supertype
chain rather than up the lexical scope chain).

### Context lines (`--context-lines N`)

Source lines immediately around a hit. Since the live database is always caught up to the
on-disk state before a query runs (per initialDesign.md's update model), this doesn't need to
be stored at all — it's a plain file read at query time, sliced around the stored line number.
Storing snippet text in the database would just be a second copy of the file that can drift
from the one on disk.

### Output shaping (concise vs. `--json`, ranking, dedup)

Not a schema requirement by itself, but it constrains query shape: results need `ORDER BY`
and `LIMIT` support for the ranking and truncation the tool's design already calls for (same-
file hits first, a capped result count with "N more not shown" rather than an unbounded
dump). Nothing here needs new tables, just query-time `ORDER BY`/`LIMIT` clauses building on
the indexes the other queries already require.

## Queries the indexer needs, not just the CLI

Two more query shapes come from how the database gets built and kept current, not from the
CLI surface directly:

- **Per-file re-index.** When a file changes, every symbol, reference, and edge that
  originated from it has to be replaced in one transaction, so a reader never observes a
  half-updated file. This needs an index on the owning file for all three kinds of row, not
  just `symbols`.
- **Checkpoint bookkeeping.** The cache-identity model in initialDesign.md needs its own
  queries: which checkpoint's tree hash is the closest match to a target commit, and — once
  chosen — which files changed since that checkpoint, both driven from data the database
  itself should hold (a per-file content hash or mtime/size pair, and a per-checkpoint tree
  hash with a last-accessed timestamp for the LRU eviction policy). This is metadata about
  the database's own state, not about the code it indexes, so it belongs in its own table
  rather than being bolted onto `symbols`.

## Schema implications

initialDesign.md's sketch — `symbols(id, file, kind, name, span_start, span_end)` and
`edges(from_id, to_id, kind)` — covers the containment and type-hierarchy walks, since those
are genuinely symbol-to-symbol relationships. It doesn't have anywhere to put a reference: a
use of a symbol is a location, not a named symbol in its own right, and there can be any
number of them. Folding references into `edges` as `(from_id, to_id, kind: "ref")` loses the
position — the whole point of `--what-refs`. That points at a third table:

```
symbols(id, file, kind, name, def_line, def_col, def_end_line, def_end_col)
edges(id, from_id, to_id, kind)        -- kind: contains | extends | implements | casts-to
occurrences(id, symbol_id, file, line, col, end_line, end_col, kind)  -- kind: read | call
```

`edges` stays symbol-to-symbol, for the two recursive walks above. `occurrences` holds one row
per concrete use — what `--what-refs` enumerates and what a snippet gets sliced around.
Splitting `def_line`/`def_col` from `def_end_line`/`def_end_col` (rather than the sketch's
single `span_start`/`span_end`) matches what `textDocument/definition` actually returns with
`linkSupport` enabled — a `targetRange` and a `targetSelectionRange` — per
docs/debugging.md's note on `LocationLink`'s response shape.

Indexes needed: `symbols(file)`, `symbols(name)`, `edges(from_id)`, `edges(kind)`,
`occurrences(symbol_id)`, `occurrences(file)` — the columns the queries above actually filter
or join on.

### File identity

docs/debugging.md records that the TypeScript LSP server's own `file://` URIs disagree with
Node's `pathToFileURL` on drive-letter case and colon encoding on Windows. Every `file`
column above has to store the same canonical form `packages/lsp-bridge/src/uri.ts`
(`toFileUri`/`fromFileUri`) already normalizes to, or a lookup keyed on a raw URI from one
source and a raw path from the other will silently miss rows instead of erroring.

## Kysely-specific requirements

- `withRecursive()` for both recursive walks (containment, type hierarchy) — the reason
  Kysely was chosen over Drizzle for this project.
- A `REGEXP` function registered on the underlying `better-sqlite3` connection before Kysely
  wraps it, since `SearchQuery.useRegExp` has no equivalent built into SQLite itself.
- WAL mode, since the daemon (plan 3) writes incrementally from the file watcher while the
  CLI (plan 4) reads concurrently.
- Migrations via Kysely's `Migrator`/`FileMigrationProvider`, written by hand rather than
  generated, since the schema above is small and not expected to change often.

## Open questions for plan 2

- Whether `occurrences.kind` needs more values than `read`/`call` — a write/assignment might
  matter for some future query, but nothing in ideas.md asks for it yet.
- Whether `edges.kind: casts-to` is derived at index time from the type checker's own
  assignability answer, or computed at query time from `extends`/`implements` alone; the
  distinction matters if TypeScript's structural typing allows a cast-compatible relationship
  that no explicit `extends`/`implements` edge would capture.
- Exact shape of the checkpoint-bookkeeping table(s) — this doc only argues that one has to
  exist, not its columns.
