# Initial Task List

High-level plan sequence. Each numbered item becomes its own plan later —
none of the plans are written yet, this is just the ordering and scope for
each.

Monorepo layout: package workspace, libraries under `packages/`, runnable
entry points (daemon, CLI) under `apps/`.

## 1. Build system + LSP bridge

- Set up the workspace: `package.json`, esbuild bundling, eslint,
  `@pathtx/prettier`, `packages/`/`apps/` structure. (Native/C++ build
  tooling is out of scope here — that's part of plan 5.)
- Implement a small LSP bridge to TypeScript's language server: spawn
  `tsserver`/the LSP-compatible server, speak the protocol to it, expose
  enough of it (references, definitions, hover/type info, etc.) to drive
  the query model designed next.

## 2. Database model

- Using what the LSP bridge actually returns (symbol shapes, reference
  data, type info), design the concrete database model: schema, storage
  backend choice (SQLite vs. DuckDB), and the cache-identity/checkpoint
  scheme from initialDesign.md.

## 3. Initial daemon implementation

- A long-running process that owns the live DB, drives the LSP bridge, and
  serves queries.
- File watching via an existing off-the-shelf package for now — not the
  custom NAPI watcher yet (that's plan 5). Swappable later without
  reworking the daemon's update logic.

## 4. CLI

- The `--query` surface from ideas.md: symbol/regexp queries, refs,
  concise/verbose output, etc., talking to the daemon.

## 5. Synchronous file system watcher NAPI plugin

- Replace the off-the-shelf watcher from plan 3 with a native, synchronous
  NAPI-based file system watcher.
- This is where the C++/native build tooling from CLAUDE.md comes in:
  CMake + Ninja, latest MSVC on Windows, and the cross-platform build
  environment tool (e.g. sourcing `vsvarsall.bat`).
