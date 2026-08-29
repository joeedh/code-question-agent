# Debugging Guide

Lessons from bugs with a non-obvious cause, kept here so the next session
starts from what was already learned.

## The TypeScript 7 LSP server (`tsc --lsp --stdio`)

Findings from `packages/lsp-bridge/test/lsp-bridge.test.ts`, which drives the
real server built from `C:/dev/TypeScript` (see `TSC_LSP_PATH`).

### File URIs lowercase the drive letter and percent-encode its colon

On Windows the server's own `file://` URIs (in `definition`/`references`
results, for example) look like `file:///c%3A/dev/foo.ts` — lowercase drive
letter, colon percent-encoded as `%3A`. Node's `pathToFileURL` produces
`file:///C:/dev/foo.ts` instead: uppercase, literal colon. The two strings
never compare equal even though they name the same file.

`packages/lsp-bridge/src/uri.ts` (`toFileUri`/`fromFileUri`) normalizes to the
server's convention. Anything that compares a URI it built against one the
server returned needs to go through it — string equality on raw
`pathToFileURL` output silently fails, and a symbol-table keyed on the wrong
casing would fail lookups without a client-visible error.

### `definition.linkSupport` changes the response shape

Advertising `textDocument.definition.linkSupport: true` in the `initialize`
capabilities (recommended, since it lets the server report the caller-side
`originSelectionRange` too) switches `textDocument/definition`'s response
from `Location[]` to `LocationLink[]` — `targetUri`/`targetSelectionRange`
instead of `uri`/`range`. `textDocument/references` is unaffected; it has no
equivalent capability and always returns plain `Location[]`.

A caller that only handles `Location[]` (checking for a `uri` field) silently
gets zero results back from a successful, well-formed request — the shape
mismatch has no error, so it looks like the symbol just has no definition.

### An unregistered request method reports `InvalidRequest`, not `MethodNotFound`

Sending a request for a method name the server doesn't implement (e.g. a
probe/typo) returns JSON-RPC error code `-32600` (`InvalidRequest`), not the
`-32601` (`MethodNotFound`) the JSON-RPC spec's own convention would suggest.
Code that branches on error code to distinguish "server doesn't support this
request" from "this request was malformed" needs to treat both the same way
against this server.

### An open document's on-disk edits are ignored until `didChange`

Once a file is opened via `textDocument/didOpen`, the server treats the
client's in-memory buffer as authoritative. Writing a change directly to the
file on disk has no effect on the server's view — `documentSymbol` and
friends keep answering from the last `didOpen`/`didChange` content — until
either a `textDocument/didChange` notification arrives or (untested here)
`workspace/didChangeWatchedFiles` is sent. Confirmed by
`test/lsp-bridge.test.ts`'s "does not pick up an on-disk edit" case.

This matters for the plan 3 daemon: a file-watcher-driven update loop must
still speak `didChange` to the server for any file it has opened — writing to
disk and hoping the server notices on its own does not work.

### `hierarchicalDocumentSymbolSupport` reports constructors and private fields as children too

`textDocument/documentSymbol` on `packages/lsp-bridge/test/fixtures/basic/greeter.ts`'s
`Greeter` class doesn't just return `sayHi` as a child — it also returns `constructor` and the
private `greeting` field. Code that maps this response into `symbols` rows (per
`packages/db/src/index-file.ts`) gets five rows for that file (`Greeter`, `constructor`,
`greeting`, `sayHi`, plus the top-level `greet` function), not the three a reader might expect
from only the class's one public method.

## The workspace's TypeScript 7 (Corsa) build tooling

Findings from setting up `packages/db`, the first package another package imports types from.

### A project whose `include` spans multiple top-level directories needs an explicit `rootDir`

`packages/lsp-bridge/tsconfig.json` and `packages/db/tsconfig.json` both list `"include":
["src", "test"]`, so their common source root is the package directory itself, not `src`.
TypeScript 7's native compiler enforces this as a hard error (`TS5011: The common source
directory ... must be explicitly set`) the moment declaration emit is attempted — the classic
JS-based `tsc` would silently infer a root and emit under a nested `dist/src/index.d.ts`
instead of erroring. Declaration output has to land at `dist/index.d.ts` to match each
package's `"types"` field, so declaration builds use a separate `tsconfig.declare.json` per
package (`rootDir`/`include` scoped to `src` only, `test` excluded) rather than the same
`tsconfig.json` the `typecheck` script uses.

### `extends` resolves a base config's own `include`/`rootDir` relative to the base file, not the leaf

Putting `"include": ["src"]` directly in the shared `tsconfig.declare.base.json` (at the repo
root) resolves to `<root>/src`, which doesn't exist, even though every package extending it has
its own `src/`. Path-valued fields (`include`, `rootDir`, `outDir`) have to live in each leaf
`tsconfig.declare.json` instead — only the non-path compiler options (`declaration`,
`emitDeclarationOnly`, `noEmit: false`) belong in the shared base.

### esbuild doesn't emit declarations, and dist output needs to exist before a dependent typechecks

`scripts/build.mjs` bundles each package with esbuild, which produces runtime JS only. A
package's `"types": "./dist/index.d.ts"` field went unfulfilled through all of plan 1 because
no package imported another's types yet; `packages/db` importing `fromFileUri` from
`@code-question-agent/lsp-bridge` surfaced it as `TS7016: implicitly has an 'any' type'`. The
fix is a `tsc --emitDeclarationOnly` pass per package after the esbuild bundle step, but since
`packages/db` depends on `packages/lsp-bridge`'s freshly emitted `dist/index.d.ts`, running
every package's declaration build in one `Promise.all` races — the build script retries
declaration builds across passes (bounded by workspace size) instead of hand-maintaining a
dependency order.

### Windows needs `{ shell: true }` to spawn a `.cmd`-shimmed binary from `child_process`

`node_modules/.bin/tsc` on Windows is a `tsc.cmd` shim. `execFile("tsc", [...])` without
`shell: true` fails with `ENOENT` — Windows only resolves `.cmd`/`.bat` extensions through a
shell, not through a bare `CreateProcess` call the way POSIX resolves a `#!` script.

### SQLite's `x REGEXP y` operator calls the registered function as `regexp(y, x)`

Registering a custom `regexp` function on a `better-sqlite3` connection (for
`SearchQuery.useRegExp`, per `docs/research/query-patterns-and-db-requirements.md`) has to
take the pattern as its first argument and the column value as its second —
`WHERE name REGEXP 'foo'` invokes `regexp('foo', name)`, not `regexp(name, 'foo')`. Getting the
argument order backwards doesn't error; it just matches nothing.

## `apps/daemon` (plan 3)

### An IPC `shutdown` handler that awaits closing its own server deadlocks

`net.Server.prototype.close(callback)` doesn't fire `callback` until every open connection has
ended, not just once the server stops accepting new ones. A `shutdown` request handler that
directly `await`s a function which calls `server.close()` never returns — the very connection
carrying that request is still open, waiting for the handler to return, which is waiting for
`close()`, which is waiting for that connection to end. `apps/daemon/src/index.ts`'s IPC-facing
`shutdown` handler answers the request immediately and defers the real shutdown with
`setImmediate`, so the JSON-RPC response reaches the caller before the server starts tearing
down. A `shutdown()` called directly (not through the IPC handler — a `SIGTERM`, or a test
calling `handle.shutdown()`) has no such connection to wait on and can `await` it directly.

### Hierarchical `documentSymbol` reports a named import as a symbol too

`caller.ts` (`packages/lsp-bridge/test/fixtures/basic/caller.ts`) does
`import { greet, Greeter } from "./greeter.js"`, and its own `documentSymbol` response
includes a `greet` entry (`SymbolKind.Variable`) for that imported binding — a second row
distinct from `greeter.ts`'s function declaration. An exact-name lookup across the whole
workspace can genuinely return more than one row for a name that looks unambiguous, without
`file`/`line`/`col` narrowing it (`SymbolQuery`'s optional fields, per `packages/core`).

### `child.kill()` on Windows always hard-kills, regardless of the signal name

Windows has no POSIX signal delivery, so `ChildProcess.kill("SIGTERM")` and `.kill("SIGKILL")`
both call `TerminateProcess()` — there's no way to ask a child to shut down gracefully via
`kill()` on this platform; a real graceful-shutdown path needs its own IPC message (this
daemon's `shutdown` request) rather than relying on signal handling. This incidentally makes
`child.kill()` a faithful stand-in for a genuine force-kill in the
`apps/daemon/test/daemon.test.ts` resilience test — no cleanup handler in the daemon runs.

### `fs.rm` needs `maxRetries`/`retryDelay` after closing a watcher or a spawned process on Windows

Deleting a temp directory immediately after `chokidar`'s `.close()` resolves, or immediately
after a spawned `tsc --lsp` process's `exit` event fires, can still hit `EBUSY` — the OS can
take a moment longer than the resolved promise to actually release the file handle. `fs.rm`'s
built-in `{ maxRetries, retryDelay }` (used in `apps/daemon/test/daemon.test.ts`'s cleanup)
is the documented fix, rather than a hand-rolled retry loop.

### A Unix domain socket path has a platform length limit a home-dir-nested path can hit

Historically ~104-108 bytes on Linux/macOS. `apps/daemon/src/repo.ts` keeps the daemon's other
state (`live.sqlite`, `checkpoints/`) under `~/.code-question-agent/repos/<repo-id>/`, but
places the POSIX socket itself under `XDG_RUNTIME_DIR` (or the OS temp dir) instead — a much
shorter, flatter path. `vscode-jsonrpc`'s own `generateRandomPipeName` (`vscode-jsonrpc/node`)
does the same thing for the same reason, which is how this was found — reading its source
before writing a from-scratch IPC address scheme, rather than after hitting the bug.

### A raw file copy of a live WAL-mode SQLite database can miss recent writes

In WAL mode, a committed write can still live only in the `-wal` file next to the main
database file until a checkpoint operation folds it back in. `apps/daemon/src/checkpoints.ts`
capturing a checkpoint from the *live*, open database uses `better-sqlite3`'s own
`.backup()` (`packages/db/src/open.ts`'s `backupDatabase`) rather than `fs.copyFile`, since
`.backup()` goes through SQLite's online backup API and is safe against a concurrently-open
connection. A plain file copy is still fine for *promoting* a checkpoint onto `live.sqlite`
before anything has opened it — the risk is specific to copying out of an already-open DB.

## `apps/cli` (plan 4)

### `Location`'s line/column numbers are 0-indexed, not 1-indexed

`packages/core`'s `Location` (and everything built on it — `ResolvedSymbol`, `Occurrence`)
carries whatever `apps/daemon/src/query.ts` copied straight out of the `symbols`/`occurrences`
tables, which in turn is whatever `documentSymbol`/`references` reported — the LSP spec's own
0-indexed `Position.line`/`.character`. A manual run surfaced this the hard way: `apps/cli`'s
first snippet-reading implementation assumed `Location.line` was already 1-indexed (matching
how a human reads a file), so `createSnippetReader` sliced the wrong line — usually one line
short of the real one, which reads as a subtly-wrong-but-not-obviously-broken empty or
off-by-one snippet rather than a crash. `apps/cli/src/snippet.ts` now treats every `Location`
line/column as 0-indexed throughout, and `apps/cli/src/format.ts`'s human formatter is the one
place that adds 1 for display — `--json` output is left exactly as the daemon reported it,
since that's meant for programmatic consumption of the same numbers the daemon itself uses.

### A workspace app gains a `"types"` field only once another member imports it

`apps/daemon` had no `"types"` field or `tsconfig.declare.json` through plan 3, per the same
reasoning as `scripts/build.mjs`'s `declareMember`: "apps aren't imported by other workspace
members." Plan 4 broke that assumption — `apps/cli` imports `resolveRepoPaths`/`connectIpc`/
`isAddressLive`/the protocol types straight from `@code-question-agent/daemon` rather than
duplicating them. Without a `"types"` field, this failed the exact way `packages/db` importing
`packages/lsp-bridge` did in plan 2 (`TS7016: Could not find a declaration file`) — the fix is
the same one: add `"types": "./dist/index.d.ts"` to `apps/daemon/package.json` and a
`tsconfig.declare.json` mirroring `packages/db`'s, so `declareMember` actually runs a
declaration build for it.

### `spawn(..., { detached: true })` pops a console window on Windows unless `windowsHide` is set too

`apps/cli/src/connection.ts`'s `spawnDaemon` spawns the daemon `detached` so it outlives the
CLI invocation — correct for keeping it alive, but on Windows a detached child gets its own
console window by default (Node's documented behavior, not a bug in the child itself). Every
CLI invocation that cold-spawns a daemon — including each `apps/cli/test/cli.test.ts` case —
flashed a visible window during a test run. The fix is `windowsHide: true` alongside
`detached: true` in the same `spawn()` call; it only suppresses the window, it doesn't affect
`detached`'s process-survival behavior. Worth checking any future `detached: true` spawn in
this codebase for the same pairing — `apps/daemon/test/daemon.test.ts`'s daemon-subprocess
spawn and `apps/daemon/src/watcher.ts`'s `git` spawns don't need it, since neither sets
`detached`.
