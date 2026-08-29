# Tooling

- **Language:** TypeScript, using the native Go-based compiler (TypeScript
  7.0, shipped July 2026 — the Go rewrite, codename Corsa, is now the
  standard `tsc` inside the `typescript` package; `tsgo` refers only to the
  bleeding-edge nightly channel). This is currently the latest TypeScript.
- **Bundler:** `pnpm build` runs esbuild.
- **Formatter:** `pnpm format` runs `@pathtx/prettier`.
- **Linter:** `pnpm lint` runs both eslint and commentlint.
- **Package Manager**: pnpm
- **Typechecking**: `pnpm typecheck`

# Documentation

- Design docs go in `docs/`.
- Research reports go in `docs/research/`.
- Plans go in `docs/plans/`; always write them to the repo rather than leaving them only in
  conversation.
- Keep a running debugging guide in `docs/debugging.md`. Add a lesson there whenever a bug
  turns out to have a non-obvious cause, so the next debugging session starts from what was
  already learned.
- The overall design lives in [`docs/initialDesign.md`](docs/initialDesign.md); the plan
  sequence lives in [`docs/initialTaskList.md`](docs/initialTaskList.md).
- Per-package reference docs: [`docs/cli.md`](docs/cli.md) (`apps/cli`),
  [`docs/daemon.md`](docs/daemon.md) (`apps/daemon`), [`docs/db.md`](docs/db.md)
  (`@code-question-agent/db`).
- Prefer bullet points over prose paragraphs in design docs, plans, and reports. A bulleted
  fact is cheaper to scan, cheaper to update in isolation, and cheaper to load into an LLM's
  context than the same fact buried in a paragraph. Reserve paragraph prose for where the
  connective logic between sentences is itself the content (a design rationale walking through
  a tradeoff), not for reference material that's really a list of independent facts.

# Packages

Workspace packages live under `packages/`; runnable apps (the daemon, the CLI) live under
`apps/`. Keep this list current as packages are added, renamed, or removed.

- `@code-question-agent/core` — shared types (`Query`, `Report`, and friends) used across the
  rest of the workspace.
- `@code-question-agent/lsp-bridge` — spawns TypeScript's native LSP server and speaks LSP to
  it (handshake, requests); see
  [plan 1](docs/plans/01-build-system-and-lsp-bridge.md).
- `@code-question-agent/db` — SQLite-backed storage (Kysely + `better-sqlite3`): schema,
  migrations, per-file indexing from `lsp-bridge` response shapes, and the cache-identity/
  checkpoint scheme; see [plan 2](docs/plans/02-database-model.md).
- `@code-question-agent/daemon` (`apps/daemon`) — the long-running process: promotes/cold-
  builds the live DB, watches the working tree, drives `lsp-bridge` to keep it current, takes
  checkpoints, and serves queries over a named pipe/Unix domain socket (never TCP); see
  [plan 3](docs/plans/03-daemon-implementation.md).
- `@code-question-agent/cli` (`apps/cli`) — the `--query` command-line entry point: spawns/
  connects to the daemon for the current repo, sends a symbol/regexp query, and renders the
  result as `ideas.md`'s concise block format or `--json`; see
  [plan 4](docs/plans/04-cli.md).

# Commentlint

Commentlint checks comments and Markdown prose against the Prose rules, using a small trained
model rather than a fixed set of regexes. `.commentlintrc.json` holds this project's
configuration; right now it only opts Markdown files into scanning.

The Comments and Prose sections both write every rule as "**Bold rule name.** Rest of the
sentence," and quote the exact bad patterns they warn against as examples. The model reads
that structure as a live violation, and disabling a rule in config only renames the finding
to the next-ranked rule rather than clearing it — the gate that decides whether a comment is
flagged runs as one score across every rule, disabled or not. `<!-- commentlint-off -->`/
`<!-- commentlint-on -->` around both sections is what actually stops them from being
scanned, and is the right tool for a passage that is itself about bad prose rather than an
instance of it.

Run `pnpm run lint:prose` for the full report, `pnpm run lint:prose:concise` for the
line:column table, or `pnpm run lint` to run it alongside eslint.

Do not add a new rule to commentlint itself. Its taxonomy is checked against a shared trained
model, so a rule this repository needs belongs in the commentlint repository, not in a local
patch. Report a finding that looks wrong with `commentlint --false-positive` (or
`--false-negative` for a miss the model should have caught) instead of quietly disabling the
rule — that feedback is what the model gets retrained against.

## Native addons (napi)

If a napi plugin becomes necessary:

- Build with CMake + Ninja.
- Use the latest MSVC, even if still in preview/experimental, on
  Windows.
- Cross-platform native builds need consistent build-environment handling
  (e.g. on Windows, the MSVC environment must be sourced from
  `vsvarsall.bat` before invoking CMake/Ninja — it isn't present by
  default). Build a small internal tool to handle this environment setup
  per-platform, rather than relying on ad hoc scripts per developer
  machine.

## Comments

Comments are prose, so the Prose rules govern them as well. The rules in this section are
the ones that apply only to code.

<!-- commentlint-off -->

- **A comment describes the code directly beneath it.** A comment placed above an `if` is read
  as a caption for the branch it guards, so one that explains the opposite case belongs on the
  `else`, or should be reworded to describe the test itself. Misplacing a comment this way is a
  correctness bug, not a style one.
- **Delete commented-out code — never leave it as commentary.** Git history holds it. A
  commented-out call, import or block explains nothing about the code that survives, and it
  goes stale silently because nothing type-checks it.
- **Never restate what the code already says.** `inputs: {}, //tool properties` and
  `case keymap.Escape: //esc` add a maintenance burden and no information. A comment earns its
  place by giving a reason, a constraint, or a consequence.
- **Cite a named constant rather than its value.** A comment saying "thirty seconds" beside
  `LINGER_MS` is wrong the first time the constant changes; write `` `LINGER_MS` ``.
- **Rename instead of commenting a name.** If the sentence's work is translating an
  identifier — what `snapMode` means, what a bare `-1` means — rename the identifier or
  introduce a named constant, then delete the sentence. Comment a name only when the name
  cannot be fixed. Try to avoid names longer than three words or 25 characters
  (10 characters or less is preferred).
- **Comment the consequence, not the arguments.** Options passed at a call site (`capture`,
  `passive`, a flag, a lifetime) are already on screen. Say what the reader cannot see: what
  the call does to everything around it. "Does not inhibit the event from reaching other
  consumers" earns its line; "registered `passive` so it cannot call `preventDefault`" does not.
- **State facts; do not defend the design.** Rationale belongs in a comment only when a reader
  looking at the surrounding code still could not derive it — an ordering constraint, a platform
  quirk, a decision with a live alternative. "Why this is the good version" and "what would go
  wrong under the naive one" are commit-message material.
- **A doc comment continues its declaration; it does not restate it.** Do not re-supply the
  subject the declaration already names, and do not narrate the signature. A field or property
  takes a noun phrase or a bare predicate — "Pointer ids currently down.", "Detected via the
  presence of multiple pointer ids." A class, function or method takes a predicate, because the
  reader needs to know what it does — "Draws the links beneath the node frames in screen space."
  A headless noun phrase over a class or a function is a fragment opener; do not use one.
  A doc comment that reads as a standalone paragraph is usually rationale in disguise.
- **Inline notes and doc comments are punctuated differently.** An inline `//` note is a
  fragment with no terminal period; a `/** … */` doc comment is a punctuated sentence. One
  line each, unless the fact genuinely needs two.
- **Non-doc comments use `//`.** Doc comments use proper `/** … */` brackets. Don't use
  `/* … */` for ordinary inline commentary.
- **Non-doc comments are at most 3 lines.** A longer block comment is allowed sparingly —
  budget roughly one per 500 lines of a file — for genuinely load-bearing context that
  can't be stated in three lines.
- **Doc comments stay reasonably concise.** Say what the thing is and any non-obvious
  contract; don't restate the signature or narrate the implementation.
- **Temporary comments are marked `CLAUDENOTE:`.** Any scratch/working comment Claude
  writes gets that prefix, and all of them must be removed before the final commit of a
  plan (or at the end of the plan, whichever comes first).

<!-- commentlint-on -->

## Prose

These rules govern every piece of prose in the repository. They apply to code comments, to
this file, and to all Markdown files.

<!-- commentlint-off -->

- **Write plain declarative prose — no epigrams.** State the constraint or decision
  directly: "An empty answer is deliberate and is passed to the model as-is", not "Empty is an
  answer — silence, said out loud." If a sentence needs a second read to parse, rewrite it.
  Specific patterns to catch:
  - **Inverted syntax and personification** — the sentence performs rather than informs.
  - **Metaphorical equations** — "The leak scan is the refusal", "what ships is identity",
    "the project as commands". The connector word varies — do not get hung up on "is"
    versus "as". Say what happens instead: "Refuses if the leak scan finds a known name
    still in the body."
  - **Fragment openers that defer the subject — never use this pattern.** Naming a placeholder
    and then withholding the real content behind a colon or a dash is always wrong: "The
    redactor to scan a report with: the one that wrote it, else one built from the project as it
    stands." Lead with a complete sentence and name each case as you reach it. A doc comment is
    not an exception, and deleting the label is not the fix, because the apposition left behind
    is still headless. Supply a predicate instead. Write "Draws the links beneath the node
    frames in screen space." rather than "The link underlay: a screen-space canvas beneath the
    node frames." or the bare "Screen-space canvas beneath the node frames."
  - **Double negatives** — "the palette cannot be relied on not to". State the positive claim.
  - **Pronouns and ellipses that point outside the sentence** — "the second case", "asking
    twice is how…" — each sentence should carry its own referents.
  - **"Clause A, else B" constructions** — "Resolve a push's destination: the named window
    when it still exists, else the focused window falling back to the most recently focused
    one." Spell out the cases as ordinary sentences instead: "Pushes to the named window if it
    still exists. Otherwise pushes to the focused window, or the most recently focused window
    if none is focused."
  - **Adverbs hung off the end of a noun phrase** — "the next pointerdown anywhere", "the
    handler above". The adverb postmodifies the noun, but the reader cannot tell on first pass
    whether it attaches to the noun or to the clause's verb, and an event or API name coined
    from a verb ("pointerdown") re-parses as a clause when an adverb follows it. Attach the
    qualification to a verb, or state it as its own fact: "the listener is on `window`".
  - **Non-assertive words under a definite** — "any", "anywhere", "ever" range over
    alternatives, so they fight a definite description that names exactly one thing. "A press
    anywhere dismisses it" reads fine; "the next pointerdown anywhere" does not.
  - **Rhetorical emphasis** — bold and italics inside a sentence mark the clause the author
    found most interesting, not the one the reader needs first. Put the load-bearing claim in
    the first sentence and drop the markup. A bolded lead-in that labels a Markdown bullet is
    structure rather than emphasis, and is fine.
  - **A head noun that is not what the thing is** — a module of commands documented as "The
    prompt an asset is generated from, as commands" asserts that the module is a prompt, then
    retracts it through a preposition. Lead with the head noun that names the thing —
    "Commands for the prompt an asset is generated from" — and demote the rest to a
    complement. A trailing ", as X" or ", in the form of X" is the same metaphorical equation
    above smuggled in through an adjunct.
- **Reserve backticks for code symbols.** Backticks belong on identifiers, types, commands,
  and file globs the reader will type. A file path cited mid-sentence as a reference —
  documentation/NodeEditor.md §3 — takes none, because marking it up gives it the same weight
  as the identifiers around it and dilutes them. Markdown link text is the one exception and
  keeps its backticks, where the marking separates a path from the prose around it rather than
  competing with nearby identifiers.
- **Bracket a subordinate alternative rather than fencing it with commas.** Parentheses mark the
material as skippable, so the reader gets a complete sentence either way; paired commas leave
it unclear whether the second comma closes an interpolation or opens a new clause. Write
"Dropping onto itself (or onto a neighbor it would split against) is not a rip". Drop any comma
that would follow the closing bracket — it separates the subject from its verb.
<!-- commentlint-on -->

## todos.md
- todos.md is a todo list
  - markdown checkbox list
  - check items off as they are completed
