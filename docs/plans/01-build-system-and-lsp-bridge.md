# Plan 1: Build System + TypeScript LSP Bridge

Companion docs: ideas.md (query surface), initialDesign.md (storage/caching model),
initialTaskList.md (where this plan sits in the overall sequence).

## Goal

Stand up the workspace tooling and a small library that can talk to TypeScript's real
language server over LSP, well enough to answer the reference/definition/hover-style queries
the rest of the tool will need. Native/C++ build tooling is out of scope here — that's plan 5.
The database model (plan 2), the daemon (plan 3), and the CLI (plan 4) build on top of this.

## Reference: the TypeScript LSP server

- A local checkout of microsoft/TypeScript lives at `C:/dev/TypeScript`. It's the Go rewrite
  (TypeScript 7's native compiler), built with Go and orchestrated through Hereby
  (`Herebyfile.mjs`), not the classic JS-based `tsserver` toolchain.
- The language server implementation is under `tsc/internal/lsp`: `server.go` is the server
  itself, `lsproto/` holds the protocol types, `lspwatcher/` is its own file-watching layer.
- The CLI entry point is `tsc/cmd/tsc`. `main.go` recognizes an `--lsp` subcommand
  (`tsc/cmd/tsc/lsp.go`); only `--stdio` transport is implemented right now, so the server
  speaks standard LSP framing over stdin/stdout, not a bespoke protocol. Treat it as a real
  standards-track LSP server — an off-the-shelf LSP client library should work against it
  directly, rather than needing a hand-rolled protocol layer the way `tsserver` would.
- It isn't built in that checkout yet. From `C:/dev/TypeScript`, `npx hereby local` (or the
  narrower `npx hereby tsgo`) runs `go build ./cmd/tsc` and produces
  `built/local/tsc.exe`. Go 1.26 and Node 24 are already on this machine.
- Once built, `tsc.exe --lsp --stdio` starts the server.

### Read the TypeScript source only as a last resort

LSP is a public, versioned spec, and the exploratory tests below exist precisely so the
bridge's behavior gets pinned down by observing the real server, not by reading Go source to
predict it. Open files under `C:/dev/TypeScript/tsc/internal/lsp` only when a test fails in a
way the spec and the server's own responses can't explain — an undocumented capability, a
response shape that doesn't match spec, or a crash. Don't read it up front to plan the
bridge's design.

## Steps

1. **Workspace scaffolding**
   - `pnpm-workspace.yaml` naming `packages/*` and `apps/*`.
   - Root `package.json`: workspace-level scripts (`build`, `lint`, `lint:prose`, `test`) and
     shared devDependencies (`typescript`, `esbuild`, `eslint`, `@pathtx/prettier`).
   - A base `tsconfig.base.json` targeting the TypeScript 7 native compiler, with each
     package's own `tsconfig.json` extending it.
   - An eslint flat config and a `@pathtx/prettier` config at the workspace root.
   - An esbuild-based build script that bundles each package's/app's entry point.
   - Verify `pnpm install`, `pnpm run lint`, and a trivial `pnpm run build` succeed against a
     near-empty workspace before writing any real code against it.

2. **`packages/lsp-bridge`: spawn and speak to the server**
   - A process wrapper that spawns `tsc.exe --lsp --stdio` (the binary's path is
     configurable, since it lives in a separate checkout this repo doesn't own) and frames
     LSP's `Content-Length`-delimited JSON-RPC messages.
   - A typed `initialize`/`initialized`/`shutdown`/`exit` handshake.
   - Enough request coverage to drive the query shapes in ideas.md: `textDocument/definition`,
     `textDocument/references`, `textDocument/hover`, and `textDocument/documentSymbol`. Which
     of these the server actually supports gets confirmed by its `initialize` response, not
     assumed ahead of time — see the tests below.

3. **Exploratory/validation tests against the real server**
   - These tests exist to find out what the server actually does, not only to check the
     bridge against an assumption. Point them at a handful of small fixture TypeScript files
     checked into the test directory — a function, a class with a method call, an import
     across two files — real code, not mocks, since observing the real server is the point.
   - Cover at least: the `initialize` handshake and its reported capabilities;
     `textDocument/definition` and `textDocument/references` on a symbol with a known set of
     call sites; `textDocument/hover` for type info; how the server's view of a file changes
     when the file changes on disk versus through `didChange` (this matters later for the
     watcher-driven daemon in plan 3); and how the server reports an error — a malformed
     request, a position outside the file — so the bridge's own error handling has a real
     shape to match.
   - Write down anything surprising or underdocumented in the server's behavior — that's
     exactly what `docs/debugging.md` is for.
   - The test setup should read the path to `tsc.exe` from an environment variable or a config
     value, not a hardcoded path, since the binary lives outside this repo.

## Done when

- `pnpm install`, `pnpm run build`, `pnpm run lint`, and `pnpm run test` all succeed from the
  repo root.
- `packages/lsp-bridge` starts the real `tsc.exe --lsp --stdio`, completes the handshake, and
  answers at least one request of each kind listed above against the fixture files, verified
  by the exploratory tests.
- Findings about the server's actual behavior land in `docs/debugging.md`, not only in test
  code or commit messages.

## Open questions

- Exact fixture set for the exploratory tests.
- Whether to pin a specific commit/build of the `C:/dev/TypeScript` checkout for
  reproducibility, or always build against whatever's currently there.
