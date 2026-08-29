# Plan 3: Initial Daemon Implementation

Companion docs: `docs/initialDesign.md` (storage/caching model), `docs/ideas.md` (query
surface), `docs/plans/01-build-system-and-lsp-bridge.md` and
`docs/plans/02-database-model.md` (prerequisites — both verified complete: `packages/lsp-bridge`
drives a real `tsc --lsp` server, `packages/db` has the schema, per-file indexing primitives,
and cache-identity/checkpoint logic).

## Context

`initialTaskList.md` scopes plan 3 as: a long-running process that owns the live DB, drives
the LSP bridge, and serves queries, using an off-the-shelf file watcher rather than the plan-5
NAPI one. Plans 1 and 2 built the two halves this wires together (`lsp-bridge` and `db`) but
neither has a live loop or a way for another process to talk to it — that's this plan.

Three constraints came from the user directly and drive the biggest design decisions below:
avoid an IPC mechanism that can leak a locked port under a Windows force-kill; keep the
daemon's own steady-state memory under 256MB (400MB acceptable for this first pass), not
counting the separately-spawned `tsc --lsp` process; default the checkpoint disk budget to 4GB.

## Decisions

**IPC: named pipes / Unix domain sockets, not TCP.** A TCP listener bound to a fixed or
ephemeral port is the thing that can misbehave under a hard kill on Windows — antivirus/
firewall holding a handle, `TIME_WAIT`-adjacent state, or just a stale "the daemon is on port
N" record nothing update if the process dies without running its cleanup handler. A named pipe
(`\\.\pipe\code-question-agent-<repo-id>` on Windows) is a kernel object tied to the owning
process; when that process is force-killed, Windows tears it down immediately — there is no
"leaked pipe" the way a socket can leak port state. POSIX gets the equivalent via a Unix domain
socket file. Both are wired up through `net.createServer().listen(path)` — Node's `net` module
already treats a pipe path and a socket path the same way, so this isn't a new dependency.

**Framing reuses `vscode-jsonrpc`, not a new wire format.** `packages/lsp-bridge/src/process.ts`
already wires `StreamMessageReader`/`StreamMessageWriter` around a Node stream — a `net.Socket`
is just as much a stream as a child process's stdio, so the same framing (`Content-Length`
headers, JSON bodies) works for daemon↔CLI, via `vscode-jsonrpc/node`'s
`createMessageConnection` directly (not `createProtocolConnection`, which is LSP-typed). One
framing library for both transports instead of inventing a second one.

**Liveness is always verified by connecting, never by trusting stored state.** This is the
actual answer to "force-killed without cleanup": nothing about correctness depends on a
graceful shutdown having run. A per-repo metadata file (`daemon.json`: pid, pipe/socket path,
started-at) is written on startup purely as a hint for where to connect — if connecting fails,
the file is stale and gets overwritten, no different from it not existing. On POSIX, a stale
Unix socket _file_ (as opposed to the kernel resource) can survive a crash; startup tries to
connect first, and only `unlink`s and rebinds after a failed connection confirms it's dead.
Windows pipes need no such dance — the OS doesn't leave a stale pipe object at all.

**One daemon process per working directory**, addressed by a repo id derived from the resolved
real path (`sha256(realpath).slice(0, 16)`) — matches `initialDesign.md`'s "one live DB per
active working directory." Data lives under `~/.code-question-agent/repos/<repo-id>/`:
`live.sqlite`, `checkpoints/`, `daemon.json`.

**The file watcher treats `git` as the source of truth for ignore rules, not a bundled ignore
library.** The initial cold-start file list comes from `git ls-files --cached --others
--exclude-standard` (already gitignore-aware). For files the watcher (`chokidar`) reports after
startup, a batched `git check-ignore --stdin` filters new/renamed paths. This continues plan
2's own choice (`packages/db/src/checkpoint.ts` shells out to `git` directly rather than adding
a git library) instead of introducing a second, potentially divergent ignore-matching
implementation.

**Checkpoints are triggered by watching `.git/logs/HEAD`, not a git hook.** The reflog file is
appended to on every ref update — commit, checkout, merge, rebase — so watching it (through the
same `chokidar` instance, alongside the tracked source tree) gives a debounced signal to take a
checkpoint without installing a hook into the user's repo, which would mean mutating
`.git/hooks/` in a way this tool doesn't own and could conflict with a hook already there.

**Disk budget: 4GB default, LRU eviction, current-HEAD checkpoints protected.** Extends
`packages/db/src/checkpoint.ts` (`listCheckpoints`/`checkpointPath` already exist) with an
eviction routine: sum checkpoint file sizes, and if over budget, delete oldest-by-mtime files
until under it, skipping any tree hash in a protected set (the current HEAD tree hash of every
worktree the daemon currently knows about) — per `initialDesign.md`'s retention policy.

**Memory: no artificial cap, but the design doesn't accumulate state that would need one.**
SQLite (via `packages/db`) is already the source of truth rather than an in-memory graph, so
steady-state RSS is dominated by Node's own baseline plus whatever's in flight for the file
currently being indexed — no full-workspace symbol cache in JS. The daemon logs
`process.memoryUsage().rss` periodically (debug-level) so regressions are visible, and the
`400MB` first-pass ceiling is a thing to notice, not a thing to enforce by killing the process.

**`packages/core`'s `Report` types get extended, not reused as-is.** `SymbolInfo.info: string`
and `WhatRefs.references: SymbolInfo[]` are too sparse to carry what the daemon can actually
produce — a reference is a location (file/line/col), not a nested report. Add structured types
the CLI (plan 4) needs for ranking, dedup, and `--json` output: a `Location` (`file`, `line`,
`col`, `endLine`, `endCol`), a `ResolvedSymbol` (`id`, `name`, `kind`, plus its `Location`), and
change `WhatRefs.references` to `Occurrence[]` (`Location` + `kind: "read" | "call"`). Add an
`EnclosingScope` report (`ResolvedSymbol` plus its containment chain) for `--include-class-
trace`. `info: string` stays as a human-readable fallback on each report, not the only payload.

**Query scope for this plan: symbol lookup, what-refs, enclosing-scope trace.** These three are
what `packages/db`'s current schema (`symbols`, `edges.kind: "contains"`, `occurrences`) can
actually answer well. Cast-compatible-types (`--search-castable-types`) needs `extends`/
`implements` edges, which nothing populates yet — no fixture in the repo has a class hierarchy,
and populating them needs a real design pass (most likely hover-text parsing on class/interface
symbols, since the LSP spec has no assignability request, per plan 2's `casts-to` decision).
That stays an open question below rather than being rushed into this plan.

## New app: `apps/daemon`

- **`src/repo.ts`** — repo id derivation, data-dir path resolution
  (`live.sqlite`/`checkpoints/`/`daemon.json`), and the platform-specific IPC address
  (`\\.\pipe\...` on `win32`, a socket file under the data dir elsewhere).
- **`src/ipc.ts`** — starts the `net.Server`, wires `vscode-jsonrpc/node`'s
  `createMessageConnection` per incoming connection, and the connect-before-unlink startup
  dance described above. Exposes `query`, `status`, and `shutdown` request handlers.
- **`src/indexer.ts`** — per-file indexing: `didOpen`/`didChange` to the `LspBridge`,
  `documentSymbols()` → `mapDocumentSymbolsToRows` → `replaceFileIndex` (all from
  `packages/db`), then `recordFileState`. Symbol/containment indexing runs eagerly per file
  change; occurrence indexing (one `references()` call per new/changed symbol) runs off a
  small FIFO work queue processed after the eager pass, so cold-start "symbols are queryable"
  happens well before "every reference is indexed" — consistent with `initialDesign.md`'s call
  for an explicit "indexing…" state rather than blocking silently on a big cold build.
- **`src/watcher.ts`** — wraps `chokidar`: seeds the initial file set from `git ls-files
--cached --others --exclude-standard`, filters later `add`/`change` events through a batched
  `git check-ignore --stdin`, debounces per-file churn, and separately watches `.git/logs/HEAD`
  for the checkpoint trigger.
- **`src/checkpoints.ts`** — cold-start promotion (via `packages/db`'s `findClosestCheckpoint`,
  copy the winning checkpoint file to `live.sqlite` before indexing starts, then let the
  watcher/indexer catch the DB up to the working tree), capture-on-reflog-change (debounced
  copy of `live.sqlite` to `checkpoints/<tree-hash>.sqlite`), and the disk-budget eviction
  described above.
- **`src/query.ts`** — turns a `packages/core` `Query` into a `Report`: exact/regexp symbol
  lookup (`symbols.name` index or the registered `REGEXP` function), what-refs (`occurrences`
  joined to `symbols`), and enclosing-scope trace (`withRecursive` walk up `contains` edges,
  terminating at a symbol with no parent) — the recursive-CTE shape
  `docs/research/query-patterns-and-db-requirements.md` flagged as the reason Kysely was
  chosen.
- **`src/main.ts`** — process entry point: resolve repo root (cwd, or an argument), acquire the
  data dir, promote from a checkpoint or cold-build, start the watcher and IPC server, handle
  `SIGINT`/`SIGTERM` for a graceful shutdown (dispose the `LspBridge`, close the DB, remove
  `daemon.json`) — understanding that a force-kill skips all of this by design, which is why
  none of the above correctness properties depend on it running.

`package.json`/`tsconfig.json` mirror the existing packages; new dependencies:
`chokidar` (watcher), `vscode-jsonrpc` (IPC framing — already resolved transitively through
`lsp-bridge`, but needs its own direct entry per pnpm's strict resolution, same lesson as
`vscode-languageserver-protocol` in plan 2).

## Changes to existing packages

- **`packages/core/src/index.ts`** — add `Location`, `ResolvedSymbol`, `Occurrence`,
  `EnclosingScope`; change `WhatRefs.references` to `Occurrence[]`.
- **`packages/db/src/checkpoint.ts`** — add `evictCheckpoints(checkpointsDir, budgetBytes,
protectedTreeHashes)`.

## Tests

- `repo.ts`: pure — same input path always yields the same id/paths; different paths yield
  different ones.
- `ipc.ts`: start a real server on a real pipe/socket, connect a real client, round-trip a
  `status` request; on POSIX, a test for the stale-socket-file recovery path (pre-create a
  socket file with nothing listening, confirm startup detects it's dead and rebinds).
- `watcher.ts`: a scratch git repo (per the pattern `packages/db/test/checkpoint.test.ts`
  already established) with tracked, untracked, and `.gitignore`d files — assert only the
  first two reach the indexing callback; commit inside it and assert the reflog-change signal
  fires once, debounced.
- `checkpoints.ts`: eviction test with synthetic checkpoint files of known sizes/mtimes against
  a small budget, asserting oldest-first eviction and that protected tree hashes survive.
- `query.ts` and `indexer.ts`: gated by `TSC_LSP_PATH` like `packages/lsp-bridge`'s and
  `packages/db`'s existing real-server tests — index `packages/lsp-bridge/test/fixtures/basic`
  end to end (through `indexer.ts`, not by hand-building rows) and query it back through
  `query.ts`, covering symbol lookup, what-refs, and the class-trace walk.

## Done when

- `pnpm install`, `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test`
  all succeed from the repo root with `apps/daemon` included.
- The daemon starts against a scratch repo, cold-indexes it, answers a symbol-lookup and a
  what-refs query over the real IPC transport, and shuts down cleanly on `SIGTERM`.
- A force-killed daemon (`SIGKILL`/`taskkill /F` in a test, where the platform allows sending
  one) leaves no state that prevents a fresh daemon on the same repo from starting and binding
  successfully.
- Findings about `vscode-jsonrpc`-over-`net.Socket`, `chokidar` behavior, or Windows named-pipe
  semantics that are non-obvious land in `docs/debugging.md`.

## Open questions carried forward

- `extends`/`implements` edge population and the cast-compatible-types query — needs a fixture
  with a real class hierarchy and a decision on hover-text parsing, deferred from plan 2 and
  now deferred again pending that design pass.
- Exact occurrence-queue backpressure once a workspace is large enough that the queue can't
  drain between file changes — not a problem the fixture-scale tests here will surface.
- Whether the CLI (plan 4) spawns the daemon on demand or requires it pre-started; this plan
  only makes the daemon startable and connectable, not self-launching from a client.
