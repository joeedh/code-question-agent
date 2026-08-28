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
