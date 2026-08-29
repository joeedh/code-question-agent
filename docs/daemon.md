# Daemon reference

`apps/daemon` — the long-running per-repo process. Owns the SQLite index
(`@code-question-agent/db`), drives a `tsc --lsp` server
(`@code-question-agent/lsp-bridge`), watches the working tree, and answers queries over IPC.
One daemon per repo, keyed by the resolved real path.

See also: [`docs/cli.md`](cli.md) for the client side,
[`docs/plans/02-database-model.md`](plans/02-database-model.md) and
[`docs/plans/03-daemon-implementation.md`](plans/03-daemon-implementation.md) for the design.

## Identity and paths (`src/repo.ts`)

- `repoId` — first 16 hex chars of `sha256(realpath(repoRoot))`. A symlinked or relative path
  to the same repo resolves to the same id, and therefore the same daemon.
- `dataDir` — `<baseDataDir>/repos/<repoId>` (`baseDataDir` defaults to
  `~/.code-question-agent`, overridable via `CODE_QUESTION_AGENT_DATA_DIR`). Holds
  `live.sqlite`, a `checkpoints/` directory, and `daemon.json`.
- `ipcAddress` — a Windows named pipe (`\\.\pipe\code-question-agent-<repoId>`) or, on POSIX,
  a Unix domain socket under `XDG_RUNTIME_DIR` (falling back to the OS temp dir) —
  deliberately *not* under `dataDir`, since a home-dir-nested socket path can exceed the
  platform length limit. Never a TCP port.
- `daemon.json` (`metadataPath`) — `{ pid, ipcAddress, startedAt }`, written after the IPC
  server is listening. A hint only; `isAddressLive` (an actual connect attempt) is the only
  check anything trusts, since a stale `daemon.json` or a stale POSIX socket file can survive
  a force-killed process.

## Startup sequence (`startDaemon`, `src/index.ts`)

1. Resolve paths, `mkdir -p dataDir`.
2. `checkpoints.promoteClosest()` — copy the closest matching checkpoint over `live.sqlite`,
   if one exists, before anything opens it.
3. Open the DB, run `reconcile(db)` — catches any file changed/removed since the promoted
   checkpoint was captured; the cold-start scan (next step) or the watcher's own events
   pick those up.
4. Spawn the LSP bridge (`LspBridge`, needs `tscPath`) and `initialize()` it.
5. Start the cold-start index in the background (`listTrackedFiles` → `indexer.indexFile`
   per file) — `status.indexing` stays `true` until it finishes; queries answer from
   whatever's indexed so far in the meantime.
6. Start the file watcher (`watchRepo`) — feeds `indexer.indexFile`/`removeFile` and the
   checkpoint capture.
7. Start the IPC server, then write `daemon.json`.

## IPC protocol (`src/protocol.ts`, `src/ipc.ts`)

JSON-RPC over the socket/pipe (`vscode-jsonrpc`). Three requests:

- `status` → `StatusResult`: `{ pid, repoRoot, startedAt, indexing }`.
- `query` → `Report`, given a `QueryRequest`: `{ query: Query, report: "symbol-info" |
  "what-refs" | "enclosing-scope" }`. `Query` (symbol name or regexp, plus optional
  `file`/`line`/`col`/`fileInclude`/`fileExclude`) lives in `@code-question-agent/core`;
  which report shape to answer with is an IPC-level concern layered on top, not part of
  `Query` itself.
- `shutdown` → closes the daemon. Answered via `setImmediate` *before* running the actual
  shutdown, because `shutdown()` closes the IPC server, which waits for every open
  connection — including the one carrying this request — to finish first; answering first
  avoids that deadlock.

`isAddressLive(address)` — the liveness check used by both the CLI and the daemon's own
startup (to refuse double-binding on POSIX): opens a real socket connection and watches for
`connect` vs. `error`. Nothing else is trusted.

## Query resolution (`src/query.ts`)

- `resolveSymbols(db, query)` — the shared core every report type funnels through.
  - `SearchQuery`: `name = <query>` or, with `useRegExp`, a SQLite `REGEXP` clause.
  - `SymbolQuery`: `name = <symbol>`, optionally narrowed by exact `file`/`def_line`/`def_col`
    (how a caller disambiguates two same-named symbols by declaration position).
  - `fileInclude`/`fileExclude` are applied last, in JS, against the filesystem path
    (`fromFileUri` on the stored `file://` URI) — not as SQL, because a user writes a pattern
    against a path, not the percent-encoded, lowercase-drive-letter URI the server returns.
    They scope by **declaring file only**: `--what-refs`/`enclosing-scope` inherit the filter
    for free since both resolve their symbol through this same function, so filtering never
    touches individual reference locations.
- `symbolLookup` → `SymbolInfo` — every row `resolveSymbols` returns.
- `whatRefs` → `WhatRefs` — resolves to exactly one symbol (`resolveOneSymbol`, throws
  `no symbol matched this query` if zero or ambiguous), then every `occurrences` row for it.
- `enclosingScope` → `EnclosingScope` — resolves one symbol, then walks `edges.kind =
  'contains'` upward via a recursive CTE, nearest scope first, empty `trace` at script root.

## Indexing (`src/indexer.ts`)

- Per file: open/update the document in the LSP bridge, fetch `documentSymbol`, replace that
  file's rows in `symbols`/`occurrences` (`replaceFileIndex`), record its content hash
  (`recordFileState`, the cache-identity/checkpoint scheme from
  [plan 2](plans/02-database-model.md)) — all of this eager, so a file's symbols are
  queryable immediately after a change.
- Occurrence indexing runs off a separate background queue: one `references()` LSP call per
  symbol in the file, queued after the eager step and drained by a serialized promise chain
  (`scheduleDrain`). A queued item is skipped if its symbol row no longer exists by the time
  it drains (the file was re-indexed again first).
- Each reference is classified `read`/`call` (`classifyOccurrenceKind`, `@code-question-agent/db`)
  by reading the source line's text around the occurrence — cached per-URI within one
  `indexFile` call so a file with many references reads its own text once.
- `indexFile`/`removeFile` failures are swallowed at the call site (`.catch(() => undefined)`)
  in `startDaemon` — a single bad file doesn't take down the cold-start scan or the watcher.

## File watching (`src/watcher.ts`)

- `chokidar.watch(repoRoot, { ignored: NEVER_WATCHED })`, where `NEVER_WATCHED` is
  `/(^|[/\\])(\.git|node_modules)([/\\]|$)/` — a cheap prefilter so a dependency install or a
  build never even raises events for paths that would be discarded anyway. `git
  check-ignore` remains the actual source of truth for what's tracked.
- Events are coalesced, not filtered per-event:
  - `add`/`change` → added to a `changed` Set (and removed from `removed`, in case of a
    delete-then-recreate in the same window); `unlink` does the reverse.
  - Each event (re)schedules a single debounced `flush()`, `debounceMs` (default `150`) after
    the last one.
  - `flush()` dispatches every queued removal, then runs **one** `filterIgnored` call (one
    `git check-ignore --stdin` spawn) over the whole batch of changes, dispatching
    `onFileChanged` only for what survives.
  - Flushes are serialized through a `flushing` promise chain so a slow batch can't overlap
    the next one and double the `git` processes in flight.
  - **Why this matters**: debouncing was previously applied only to the cheap dispatch, after
    an unbatched per-event `filterIgnored` call — so a write burst (`pnpm install`, a build)
    spawned one `git` process per file, thousands at once, racing to start `git
    fsmonitor--daemon` on repos with `core.fsmonitor` on and leaking dozens of orphaned
    daemons. See `docs/debugging.md`'s "Debouncing after a process spawn does not limit
    process spawns" entry for the full incident.
- Separately, `.git/logs/HEAD` (the reflog, appended on every ref update — commit, checkout,
  merge, rebase) is watched on its own debounce and triggers `checkpoints.captureCurrent()` —
  chosen over a git hook this tool doesn't own.
- `close()` cancels any pending flush timer, closes both chokidar watchers, then awaits the
  in-flight `flushing` chain so nothing dispatches into a torn-down daemon.

## Checkpoints (`src/checkpoints.ts`)

- A checkpoint is a copy of `live.sqlite` at a given git tree hash, under `checkpoints/`.
- `promoteClosest()` — before the live DB is opened, finds the checkpoint closest to the
  current tree hash (`findClosestCheckpoint`) and copies it over `live.sqlite`. A plain file
  copy is safe here since nothing has either file open yet.
- `captureCurrent()` — backs up the (already-open, live) DB to a checkpoint for HEAD's
  current tree hash, then evicts over `DEFAULT_CHECKPOINT_BUDGET_BYTES` (`evictCheckpoints`,
  keeping the just-captured one).
- Triggered by the reflog watcher above — captures happen on ref changes, not on every file
  edit.

## Shutdown

- `shutdown()` is idempotent (`shuttingDown` guard) and runs in this order: await the
  cold-index promise, close the watcher, close the IPC server, dispose the LSP bridge, close
  the DB, delete `daemon.json`.
- Reached via `SIGINT`/`SIGTERM` (`main()`, standalone process) or the `shutdown` IPC request
  (currently nothing in this workspace sends it — the CLI never shuts the daemon down).
- A force-killed daemon (`SIGKILL`, no cleanup handlers run) leaves no state that blocks a
  fresh daemon from starting on the same repo — `daemon.json` and any stale POSIX socket file
  are only ever treated as hints, never trusted without `isAddressLive` confirming them.

## Environment variables

- `TSC_LSP_PATH` — required. Path to a `tsc` binary built with `--lsp --stdio` support.
- `CODE_QUESTION_AGENT_DATA_DIR` — overrides the default `~/.code-question-agent` base data
  directory. Mainly for tests, so each test repo gets isolated state.
