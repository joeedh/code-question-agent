# Initial Design

Working notes from early design discussion. Companion to ideas.md (query
shape / CLI surface) — this doc covers the storage and caching model
underneath it.

## Goal

An LLM-optimized codebase query tool, wrapping a real language server (LSP)
on the backend rather than doing our own text/AST analysis. See ideas.md
for the query surface (`--what-refs`, `--include-class-trace`, concise vs.
verbose output, etc.).

The query surface follows one guiding principle: an agent's bottleneck is
tokens and turns, not raw capability. So the tool should prefer returning
pre-digested relational answers (refs, call traces, enclosing-scope
context, type/cast compatibility) over raw grep-style hits, and should
support batching several related questions into one call. Concise, ranked,
deduplicated output is a first-class feature, not an afterthought — an agent
can't visually skim 200 results the way a human scans an IDE panel.

## Why cache a model instead of querying LSP live

LSP servers are session/workspace-oriented and slow to cold-start on a large
repo. To make a CLI-style, per-query tool responsive, we build and persist a
model of the code structure (symbols + relationships) rather than
re-deriving it from the LSP server on every invocation.

## Storage backend

Considered an embedded graph database (Kùzu) for native multi-hop /
Cypher-style traversal. Rejected: Kùzu was archived in October 2025 after
its team was acquired by Apple, and its community forks (LadybugDB,
bighorn) are early-stage with no funding or roadmap — same abandonment risk,
just earlier in the cycle.

**Decision:** SQLite (or DuckDB) as the storage backend, not a graph-native
engine. Rationale:

- Both are embedded, single-file, no server process — fits a CLI tool.
- Both are disk-backed with indexed lookups, so we never need to hold the
  whole graph in memory — queries fetch only the rows/pages they touch.
- Both support `WITH RECURSIVE`, which covers the traversal depth our query
  shapes actually need (references, one-level enclosing-scope trace, type
  hierarchy). We don't currently have a query shape that needs deep,
  ranked, multi-hop graph algorithms.
- Decades (SQLite) or strong current backing (DuckDB/MotherDuck) — much
  lower risk of the project disappearing out from under us.

SQLite favors high-frequency small incremental writes (re-indexing one file
at a time as it changes, inside a transaction). DuckDB favors bulk/
analytical scans over the symbol table. Not yet decided between the two;
leaning SQLite (`better-sqlite3`) for the write pattern, since the file
watcher will be doing frequent small updates rather than bulk loads.

### Schema sketch (not final)

```
symbols(id, file, kind, name, span_start, span_end)
edges(from_id, to_id, kind)   -- kind: ref | call | extends | casts-to | contains
```

Indexed on symbol id, file, and edge kind — the columns queries actually
filter on.

## Cache identity: content hash, not branch name

Initial idea was a manually-built key from branch name plus recursive
submodule branch/commit state (e.g.
`feature:[submodule-path]feature:[submodule2-path]:C`). Rejected in favor
of git's own content-addressed hash:

- A branch name is a mutable pointer, not a content identity — it doesn't
  tell you whether a cached DB still matches the tree.
- A git submodule is a gitlink: a commit SHA recorded directly in the
  parent tree object. So the parent repo's tree hash already recursively
  encodes every submodule's pinned commit — arbitrary nesting depth,
  multiple submodules, submodules-within-submodules, all folded into one
  hash for free. No need to hand-walk `.gitmodules` and build a delimited
  string.
- Using the tree hash also gives free dedup: two branches pointing at the
  same commit share one cache entry.

This only covers committed state. Two things aren't representable as a
clean key and need to be handled as an overlay on top of a tree-hash base
snapshot instead:

- Uncommitted working-tree changes (the common case — it's why we have a
  file watcher at all).
- A submodule checked out to something other than its parent's recorded
  gitlink pointer (common with manual `cd submodule && git checkout X`).
  Detected by comparing the submodule's on-disk HEAD to the recorded
  gitlink at lookup time; treated recursively the same way as a dirty
  top-level file.

## Update model: one live DB, not one DB per commit

Content-hash keying implies "a new DB per commit," which conflicts with the
build cost. Resolved by separating two things that were previously
conflated:

- **One live DB per active working directory**, kept current in real time
  by an OS-level file watcher (inotify / FSEvents / ReadDirectoryChangesW —
  not polling), mutated incrementally as files change. Queries block on the
  watcher being caught up, which should be near-zero cost in the common
  case since changes are pushed as they happen rather than discovered as a
  backlog at query time.
- **Checkpoint snapshots**, keyed by tree hash, that exist purely to seed a
  fast cold start (tool launched fresh, or pointed at a branch/worktree
  it's never seen live). A checkpoint is just a filesystem copy of the live
  DB file at a good moment (after a commit, after a checkout) — cheap,
  because making one isn't a rebuild.

### Cold start / branch switch

When there's no live DB for the current state (fresh launch, or switching
to an unfamiliar branch/worktree):

1. Search existing checkpoints for the closest match — not by graph
   distance, but by `git diff --name-status --find-renames <candidate>
<target>` file-change count. A candidate two hops away with a small
   diff beats a one-hop candidate that sits across a big refactor.
2. Apply that diff in place onto the candidate checkpoint (reparse
   changed files, path-rewrite renames, drop removed files) rather than
   physically cloning to a new DB file first. This is what actually keeps
   disk usage bounded — we're not accumulating one full DB per commit ever
   visited, just a live DB per worktree plus a handful of checkpoints.
3. If no candidate is reasonably close (first time on this repo, or a
   genuinely unrelated branch), fall back to a full cold build. This is the
   one path where the block could be long, and the tool should surface an
   explicit "indexing…" state rather than blocking silently.

## Retention / eviction

Since checkpoints are cheap single-file copies rather than rebuild
artifacts, the retention policy can be simple:

- Always keep the checkpoint for current HEAD of each branch checked out in
  an active worktree.
- LRU-evict checkpoints for branches/commits not recently visited, under a
  disk budget.

This keeps the checkpoint set naturally small and self-limiting without
needing to enumerate branch/submodule combinations up front.

## Open questions

- SQLite vs. DuckDB — needs a decision once write/read patterns are
  clearer.
- Exact trigger points for taking a checkpoint (post-commit hook?
  post-checkout hook? idle-time heuristic?).
- How "closest match" search scales once the checkpoint set is large —
  may need to cap the number of candidates diffed per lookup.
- Final schema for `symbols`/`edges`, including how call traces and
  cast-compatible types are represented and queried.
