# CLI reference

`apps/cli` — the `code-question-agent` command. Spawns/connects to the per-repo daemon
(`apps/daemon`), sends one query, prints the answer, exits. It never shuts the daemon down.

See also: [`docs/daemon.md`](daemon.md) for what's on the other side of the connection,
[`docs/plans/04-cli.md`](plans/04-cli.md) for the original design.

## Invocation

```
code-question-agent <query> [flags]
```

- `<query>` — the only positional argument. A symbol name (default) or a regexp pattern
  (with `--regexp`). Required unless `--query-file` or `--help` is given; missing it throws
  before any daemon contact.

## Flags

**What to look up**

- `--regexp` — treat `<query>` as a name regexp (`SearchQuery`) instead of an exact symbol
  name (`SymbolQuery`).
- `--query-file <path>` — read `<query>` from this file instead of the positional argument,
  trimmed of surrounding whitespace. Mutually exclusive with `<query>`; passing both throws
  before any daemon contact.
- `--file <path>` — disambiguate by declaring file (exact match against the stored `file://`
  URI). `SymbolQuery` only.
- `--line <n>` / `--col <n>` — disambiguate by declaration position (0-indexed, matching the
  LSP convention the daemon stores). `SymbolQuery` only.
- `--include <regexp>` / `--exclude <regexp>` — narrow by declaring file, tested against the
  filesystem path (not the raw URI). Keep a symbol only if `--include` matches and
  `--exclude` doesn't. Applies to `SymbolQuery` and `SearchQuery` alike, and to `--what-refs`
  (it narrows which declaration the references are for, not the reference locations
  themselves). A malformed pattern throws immediately, before any daemon contact, as
  `--include: <reason>` / `--exclude: <reason>`.

**What kind of answer**

- `--what-refs` — answer with references to the (single) matching symbol instead of its
  declaration(s). Throws `no symbol matched this query` if the filters above eliminate every
  candidate, or if more than one remains ambiguous — narrow with `--file`/`--line`/`--col` or
  `--include`/`--exclude` first.
- `--include-class-trace` — for each resolved symbol, also fetch its chain of enclosing named
  scopes (class, namespace, …) and print it as a `inside Foo.bar` line above the snippet, or
  `inside (script root)` at top level. One extra daemon round-trip per resolved symbol.

**Output shape**

- `--json` — print the raw `Report` as JSON (0-indexed line/col, exactly as the daemon
  returns it) instead of the human-readable block format. Includes a `traces` object keyed by
  `ResolvedSymbol.id`, populated only when `--include-class-trace` was passed.
- `--context-lines <n>` (default `0`) — extra source lines to print above/below each
  match, clamped to the file's bounds.
- `--include-line` (default `true`) — prefix each printed source line with its 1-indexed line
  number.
- `--exclude-column` — drop the `:col-endCol` suffix from a block's header, leaving just the
  line range.

**Connection**

- `--repo <path>` (default: `process.cwd()`) — which repo's daemon to talk to.
- `--no-wait` — skip polling `status` for the cold-start index to finish; answer from
  whatever's indexed so far. Without this flag, the CLI prints `indexing…` once and polls
  until `status.indexing` goes false or `--timeout` is hit.
- `--timeout <ms>` (default `120000`) — deadline for both waiting on cold-start indexing and
  waiting for a freshly spawned daemon to start listening.

**Diagnostics**

- `-v` / `--verbose[=tags]` — print progress/diagnostic lines to stderr
  (`createVerboseLogger`, `src/verbose.ts`). A bare `-v` (or `--verbose`) enables every tag;
  `-v=<tags>` — comma-separated, also accepted as `-v<tags>` (no `=`) or `--verbose=<tags>` —
  scopes it to just those. Parsed by hand in `extractVerboseFlag` (`src/args.ts`) before
  `parseArgs` sees the rest of `argv`, since `parseArgs` has no "optional value" option type
  and would otherwise reject a bare `-v`.
  - `scan` — cold-start indexing progress: `waitForIndexing` (`src/connection.ts`) prints
    `[scan] indexing… <filesIndexed>/<filesTotal> files` each time the daemon's `status`
    response changes, instead of the plain one-time `indexing…` notice. This is the tag `-v`
    enables with no arguments, so a bare `-v` is guaranteed to show cold-start scan progress.
  - `daemon` — daemon lifecycle: logs spawning a new daemon, it starting to listen, or
    connecting to one already running.
- `--help` / `-h` — print usage and exit. Short-circuits before `<query>` is required and
  before any daemon contact, so it works without `TSC_LSP_PATH` set.

## Human output format

One block per match (definition or reference), separated by a blank line:

```
== <path>:<line>[-<endLine>][:<col>-<endCol>] :<label> ==
  inside Foo.bar          (only with --include-class-trace)
<line>: <source text>     (one per snippet line; --include-line controls the number prefix)
```

- `<label>` is `definition:<kind>` for a symbol-info block, `ref:<kind>` for a what-refs
  block. `<kind>` is whatever `documentSymbol`/`references` classified the occurrence as
  (`classifyOccurrenceKind` in `@code-question-agent/db`, e.g. `read`/`call` for references).
- `<path>` is printed relative to `process.cwd()`.
- No matches prints `no matching symbols` (symbol-info) or
  `no references found for <name>` (what-refs) instead of an empty block list.

## Daemon lifecycle (from the CLI's side)

- `ensureDaemon(repoRoot, opts)` computes the deterministic IPC address for `repoRoot` via
  `resolveRepoPaths` (same hash-of-realpath scheme the daemon uses — no need to read a
  spawned process's stdout to find it) and checks `isAddressLive`.
- If nothing's listening: resolves a `tsc --lsp` binary via `resolveTscPath(repoRoot)`
  (`@code-question-agent/lsp-bridge`) — `TSC_LSP_PATH` if set, else an npm/pnpm-installed
  `typescript` (7+) found in the repo's own `node_modules` — then spawns the daemon detached
  (`detached: true, windowsHide: true, stdio: "ignore"`) with that path passed through as
  `TSC_LSP_PATH` in its environment, `unref()`s it so it outlives this process, and polls
  `isAddressLive` every 150ms until `--timeout` is hit. `resolveTscPath` is called here, before
  spawning, rather than left to the daemon's own `main()` to resolve — the daemon runs detached
  with `stdio: "ignore"`, so an error thrown after spawning would be invisible and just show up
  as a `--timeout` "timed out waiting for the daemon to start listening" instead of a clear
  message.
- Only needed to *spawn* a daemon; connecting to an already-running one needs neither
  `TSC_LSP_PATH` nor an installed `typescript`.
- `-v`'s `daemon` tag logs which `tscPath` a spawn resolved to.
- Once connected, the CLI never sends `shutdown` — the daemon keeps running for the next
  invocation.

## Exit behavior

- Any thrown error (bad flags, no daemon reachable, no symbol matched, …) is caught in `main`,
  printed as `Error: <message>`, and sets `process.exitCode = 1`.
- The IPC connection is always `dispose()`d in a `finally`, even on error.
