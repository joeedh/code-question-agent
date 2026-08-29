# Plan 4: CLI

Companion docs: `docs/ideas.md` (query surface / output examples), `docs/initialDesign.md`
(the "indexing…" state and live-DB model), `docs/plans/03-daemon-implementation.md`
(prerequisite — verified complete: `apps/daemon` exposes `status`/`query`/`shutdown` over a
named-pipe/Unix-socket `MessageConnection`, and `apps/daemon/src/index.ts` already exports
`resolveRepoPaths`, `connectIpc`, `isAddressLive` with a comment noting they're "used by tests
and, later, the CLI").

## Context

`initialTaskList.md` scopes plan 4 as: the `--query` surface from `ideas.md`, talking to the
daemon. Plan 3 built a daemon that serves `symbol-info`, `what-refs`, and `enclosing-scope`
reports over IPC but has no client and, deliberately, no self-launch behavior ("this plan only
makes the daemon startable and connectable, not self-launching from a client" — plan 3's last
open question). This plan answers that question and builds the actual command-line entry point
an LLM agent (or a human) invokes.

`packages/core`'s `Query`/`Report` types (`SymbolQuery`, `SearchQuery`, `SymbolInfo`,
`WhatRefs`, `EnclosingScope`) and the daemon's three-report scope are the ceiling for what this
CLI can ask for — `ideas.md`'s `--search-castable-types` and glob-scoped positional file
arguments need `extends`/`implements` edges and file-glob-aware querying that don't exist yet
(same deferred item plan 3 already flagged). This plan implements everything else in
`ideas.md`'s example: exact/regexp symbol search, `--what-refs`, `--include-class-trace`,
`--context-lines`, `--include-line`/`--exclude-column`, concise text output, and `--json`.

## Decisions

**New app: `apps/cli`, depending on `@code-question-agent/daemon` as a workspace package.**
`apps/daemon/src/index.ts` already barrel-exports `resolveRepoPaths`, `connectIpc`,
`isAddressLive`, and the protocol types/constants specifically for this. No new IPC or
repo-resolution logic needed — the CLI reuses plan 3's. Since another workspace member now
imports `apps/daemon`'s types, it needed a `"types"` field and a `tsconfig.declare.json` of its
own (it didn't need one when it was a leaf app in plan 3 — same lesson as `packages/db`
importing `packages/lsp-bridge` in plan 2).

**Argument parsing: `node:util`'s built-in `parseArgs`, no new dependency.** The flag surface
(`--what-refs`, `--json`, `--context-lines <n>`, etc.) is boolean/string/counted flags plus one
positional — well within `parseArgs`'s `{ options, allowPositionals }` support. This continues
the project's existing pattern of reusing what's already there (`git` as the ignore-rule source
of truth, `vscode-jsonrpc` reused for a second transport) over adding a library for something
the platform already does.

**The CLI spawns the daemon on demand; the daemon stays running after the CLI exits.**
Liveness is checked the same way `apps/daemon`'s own tests check it: compute the deterministic
IPC address via `resolveRepoPaths` (pure function of the resolved repo root — no need to read
the daemon's stdout), call `isAddressLive`, and if false, spawn
`node <resolved @code-question-agent/daemon entry>> <repoRoot>` detached and unreferenced
(`{ detached: true, stdio: "ignore" }`, `child.unref()`), forwarding `TSC_LSP_PATH` from the
CLI's own environment (fails fast with a clear error if unset — same requirement
`apps/daemon`'s `main()` already enforces). Poll `isAddressLive` until it returns true or a
bounded timeout elapses, then `connectIpc`. The CLI never calls `shutdown` — the daemon is a
long-lived, one-per-working-directory process per `initialDesign.md`, and each CLI invocation
is a short-lived client of it.

Known race, accepted for this first pass rather than engineered around: two CLI invocations
launched concurrently against a cold repo can both observe "not live" and both spawn a daemon;
the second one's `startIpcServer` throws on the address already being bound and that daemon
process exits. The first spawn still succeeds and both CLI invocations converge on it.

**Indexing state is surfaced, not hidden.** After connecting, the CLI calls `status`; if
`indexing` is true (and `--no-wait` wasn't passed), it prints a one-time "indexing…" notice to
stderr and polls `status` (short interval, bounded overall timeout) until it flips false, before
running the actual query — `initialDesign.md` calls for an explicit indexing state rather than
either blocking silently or answering off a partial index without saying so.

**`--include-class-trace` issues a second `enclosing-scope` request per resolved symbol and
merges it client-side**, rather than the daemon growing a combined report type. The daemon's
`QueryRequest.report` is deliberately one of three fixed report shapes (plan 3); a merged
"what-refs with trace" report is a daemon-side change this plan doesn't need to make when the
CLI can just issue the second request per resolved symbol and stitch the trace into its own
formatted output.

**Snippet/context-line extraction happens client-side, by reading the source file directly.**
The daemon's `Occurrence`/`ResolvedSymbol` types carry a `Location` (file/line/col span) but not
surrounding source text — the CLI runs on the same machine as the files it's querying, so
`--context-lines <n>` is implemented by reading each referenced file (once per file per
invocation, cached in memory) and slicing out the requested line window, rather than teaching
the daemon to serve source text it doesn't otherwise need.

**`Location`'s line/column numbers are 0-indexed (raw LSP convention); the human-readable
format displays 1-indexed line/column numbers, `--json` does not.** `packages/core`'s
`Location` carries whatever `documentSymbol`/`references` returned, which is 0-indexed per the
LSP spec — confirmed by manual testing (`greet` declared at reported `col: 16` genuinely starts
16 characters into `export function greet(...)`). `formatJson` passes the report through
unmodified, since it's meant for programmatic/LLM consumption of the same data the daemon
itself works with. `formatHuman` adds 1 to every displayed line/column, matching `ideas.md`'s
own example output (`32: bleh`) and ordinary editor/grep conventions — this conversion is
purely a presentation-layer concern in `apps/cli/src/format.ts`, not a change to the daemon or
`packages/core`'s data model.

**Query scope for this plan mirrors the daemon's**: exact-name or regexp symbol search
(`SymbolQuery`/`SearchQuery`), `--what-refs`, `--include-class-trace`. `--search-castable-types`
and glob-scoped positional file arguments from `ideas.md`'s example stay out of scope — carried
forward as open questions, same as plan 3's `extends`/`implements`-edge deferral.

### Addendum: `--include`/`--exclude` regexp file filters, scoped to a symbol's declaring file

Added after the initial plan-4 implementation, in response to a direct request: narrow a query
by path, e.g. "only `greet` declared under `src/`, not `test/`." Confirmed with the user that
the filter applies to where a symbol is _declared_, not to each individual reference's file —
so `--what-refs --include 'src/'` means "references to whichever matching symbol is declared
under `src/`," not "references that themselves live under `src/`."

`fileInclude?`/`fileExclude?` live on `packages/core`'s `QueryBase` (shared by both `Query`
variants). `apps/daemon/src/query.ts`'s `resolveSymbols` applies them in JS, right after the DB
fetch and before mapping to `ResolvedSymbol[]` — converting each row's `file` (a `file://` URI)
to a filesystem path via `fromFileUri` (`@code-question-agent/lsp-bridge`) and testing a plain
`new RegExp(pattern)` against it, rather than pushing a `REGEXP` clause into SQL, since a user
writes a pattern against a path, not the percent-encoded, lowercase-drive-letter URI the server
returns. `whatRefs`/`enclosingScope` inherit the filter for free, since both resolve their
symbol through this same function. A row survives when `fileInclude` (unset or matching) AND
`fileExclude` (unset or not matching) — the conventional include/exclude combination.

`apps/cli/src/args.ts` validates `--include`/`--exclude` at parse time
(`new RegExp(value)`, rethrown as a clear `--include: ...`/`--exclude: ...` message on a
`SyntaxError`) rather than letting a malformed pattern reach the daemon as an opaque exception.
`apps/cli/src/query.ts`'s `buildQuery` copies both onto whichever `Query` variant it builds.

Repeatable/multiple `--include`/`--exclude` patterns (OR-combined) and an occurrence-level
filter (scoping references by file independent of the declaring symbol) were both considered
and explicitly deferred — a single pattern per side covers the request as given.

## New app: `apps/cli`

- **`src/args.ts`** — `parseCliArgs(argv)` wrapping `node:util`'s `parseArgs`, returning a typed
  `CliOptions`: `query`, `regexp`, `whatRefs`, `includeClassTrace`, `file?`, `line?`, `col?`,
  `contextLines` (default `0`), `includeLine` (default `true`), `excludeColumn`, `json`,
  `repo?`, `noWait`, `timeoutMs` (default 120s, both for daemon-spawn liveness polling and
  indexing-wait polling).
- **`src/connection.ts`** — `ensureDaemon(repoRoot, opts)`: `resolveRepoPaths` →
  `isAddressLive` → spawn-if-needed (resolving the daemon's entry point via
  `import.meta.resolve("@code-question-agent/daemon")`) → poll-until-live → `connectIpc`.
  `waitForIndexing(connection, opts)`: polls `REQUEST_STATUS` until `indexing` is false or
  timeout, printing the one-time stderr notice.
- **`src/query.ts`** — `buildQuery(opts)`: `CliOptions` → `Query`. `runQuery(connection, opts)`:
  sends `REQUEST_QUERY` with `report: opts.whatRefs ? "what-refs" : "symbol-info"`; when
  `opts.includeClassTrace`, follows up with one `enclosing-scope` request per resolved symbol
  and attaches the resulting `trace`. `resolvedSymbolsOf(report)` is the shared helper both this
  module and `format.ts` use to get the `ResolvedSymbol[]` out of either report shape.
- **`src/snippet.ts`** — `createSnippetReader()` returning `{ read(location, contextLines) }`:
  reads a file once (cached for the invocation's lifetime) and returns the clamped, 0-indexed
  `[startLine, lines]` window around a `Location`.
- **`src/format.ts`** — `formatHuman(result, opts, snippetReader)` producing the
  `== file:line-line:col-col:label ==` block style from `ideas.md`, converting every displayed
  line/column to 1-indexed; `formatJson(result)` JSON-stringifying the report(s) plus any
  attached traces (keyed by resolved-symbol id), untouched.
- **`src/index.ts`** — entry point (`#!/usr/bin/env node` shebang, guarded the same way
  `apps/daemon/src/index.ts` guards its `main()`): `parseCliArgs` → `ensureDaemon` →
  `waitForIndexing` unless `--no-wait` → `buildQuery`/`runQuery` → format (human or `--json`) →
  `console.log` → `connection.dispose()` (does **not** shut down the daemon).

`package.json` mirrors `apps/daemon`'s, plus `"types": "./dist/index.d.ts"` (nothing imports
`apps/cli` itself, so this is only for consistency, not required) and a `"bin"` entry pointing
at `./dist/index.js`. Dependencies: `@code-question-agent/core`, `@code-question-agent/daemon`,
`@code-question-agent/lsp-bridge` (for `fromFileUri`/`toFileUri`), `vscode-jsonrpc` (direct
dependency needed for its own strict-resolution reasons, same lesson as `apps/daemon`). No new
third-party packages.

## Tests (`apps/cli/test/`)

- `args.test.ts` — pure: flag parsing, defaults, the positional query, error on a missing
  positional or a non-numeric flag.
- `snippet.test.ts` — pure: writes a small scratch file, asserts context-line windowing and
  clamping at file start/end, using 0-indexed `Location`s.
- `format.test.ts` — pure: feeds hand-built `SymbolInfo`/`WhatRefs`/`EnclosingScope` fixtures
  (plus a scratch source file for the snippet-reading path) into `formatHuman`/`formatJson` and
  asserts the block structure / JSON shape, including the `includeLine`/`excludeColumn` and
  trace-line variants, and the 0-to-1-indexed display conversion.
- `cli.test.ts` — gated by `TSC_LSP_PATH` like `apps/daemon/test/daemon.test.ts`: builds a
  scratch git repo with a declaration and a cross-file caller, runs the built CLI
  (`apps/cli/dist/index.js`) as a real subprocess — first invocation cold-spawns a daemon and
  returns a correct `symbol-info` result, second invocation reuses the same daemon (checked via
  `status.pid` staying the same across both). Also covers `--what-refs` +
  `--include-class-trace` and default human-format output. Cleans up by connecting once at the
  end and sending `REQUEST_SHUTDOWN`, with the same `fs.rm` `{ maxRetries, retryDelay }`
  Windows-handle-release pattern used in `apps/daemon/test/daemon.test.ts`.

## Done when

- `pnpm install`, `pnpm run build`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test`
  all succeed from the repo root with `apps/cli` included.
- Running the built CLI against a scratch repo with no daemon running cold-spawns one, prints a
  correct result for an exact-name query, a regexp query, `--what-refs`, and
  `--include-class-trace`; a second invocation immediately after reuses the already-running
  daemon instead of spawning another. Verified both via the automated `cli.test.ts` suite and a
  manual run against a real scratch repo.
- `--json` output round-trips through `JSON.parse` and matches the shape of the underlying
  `packages/core` report type(s).
- Findings about `parseArgs`, `import.meta.resolve` for a workspace package's entry point, or
  the LSP 0-indexed position convention land in `docs/debugging.md`.

## Open questions carried forward

- `--search-castable-types` — still blocked on the `extends`/`implements` edge population plan
  3 deferred.
- Glob-scoped positional file arguments (`src/**.ts` in `ideas.md`'s example) — the query layer
  only supports a single optional `file` filter today, not multi-file glob scoping.
- The concurrent-cold-spawn race described above — harmless (the losing spawn's process exits
  once its `startIpcServer` throws) but not locked against; worth revisiting if it ever causes
  visible log noise for a user.
