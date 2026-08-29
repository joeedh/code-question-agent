import { parseArgs } from "node:util";

export interface CliOptions {
  help: boolean;
  query: string;
  /** Path to read `query` from instead of the positional argument. Mutually exclusive with it. */
  queryFile?: string;
  regexp: boolean;
  whatRefs: boolean;
  includeClassTrace: boolean;
  file?: string;
  line?: number;
  col?: number;
  fileInclude?: string;
  fileExclude?: string;
  contextLines: number;
  includeLine: boolean;
  excludeColumn: boolean;
  json: boolean;
  repo?: string;
  noWait: boolean;
  timeoutMs: number;
  verbose: boolean;
  /** Restricts `verbose` output to these tags. `undefined` (a bare `-v`) means every tag. */
  verboseTags?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

function parseIntFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed))
    throw new Error(`--${name} expects an integer, got ${JSON.stringify(value)}`);
  return parsed;
}

function parseRegExpFlag(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    new RegExp(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`--${name}: ${reason}`, { cause: error });
  }
  return value;
}

interface ExtractedVerbose {
  verbose: boolean;
  verboseTags?: string[];
  /** `argv` with every `-v`/`--verbose` token removed, for `parseArgs` to see. */
  rest: string[];
}

/**
 * `node:util`'s `parseArgs` has no "optional value" option type, so `-v`/`--verbose` (with an
 * optional `[=tags]`) is parsed by hand rather than declared as a `parseArgs` option. A bare
 * `-v` requires no attached value; `parseArgs` treats a `type: "string"` option as *requiring*
 * one, which would reject it.
 */
function extractVerboseFlag(argv: string[]): ExtractedVerbose {
  let verbose = false;
  let sawBare = false;
  const tags = new Set<string>();
  const rest: string[] = [];

  for (const arg of argv) {
    if (arg === "-v" || arg === "--verbose") {
      verbose = true;
      sawBare = true;
      continue;
    }
    const raw = arg.startsWith("--verbose=")
      ? arg.slice("--verbose=".length)
      : arg.startsWith("-v")
        ? arg.slice(2).replace(/^=/, "")
        : undefined;
    if (raw === undefined) {
      rest.push(arg);
      continue;
    }
    verbose = true;
    for (const tag of raw.split(",")) {
      const trimmed = tag.trim();
      if (trimmed) tags.add(trimmed);
    }
  }

  return { verbose, verboseTags: sawBare || tags.size === 0 ? undefined : [...tags], rest };
}

/** Parses `argv` (excluding `node`/script) into `CliOptions`. Throws on a missing query or a malformed numeric flag, unless `--help`/`-h` is present. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { verbose, verboseTags, rest } = extractVerboseFlag(argv);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      regexp: { type: "boolean", default: false },
      "what-refs": { type: "boolean", default: false },
      "include-class-trace": { type: "boolean", default: false },
      file: { type: "string" },
      line: { type: "string" },
      col: { type: "string" },
      include: { type: "string" },
      exclude: { type: "string" },
      "context-lines": { type: "string" },
      "include-line": { type: "boolean", default: true },
      "exclude-column": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      repo: { type: "string" },
      "no-wait": { type: "boolean", default: false },
      timeout: { type: "string" },
      "query-file": { type: "string" },
    },
  });

  const query = positionals[0];
  const queryFile = values["query-file"];
  if (!values.help) {
    if (query !== undefined && queryFile !== undefined)
      throw new Error("a positional query and --query-file are mutually exclusive");
    if (query === undefined && queryFile === undefined)
      throw new Error("a query (symbol name or regexp) is required");
  }

  return {
    help: values.help,
    query: query ?? "",
    queryFile,
    regexp: values.regexp,
    whatRefs: values["what-refs"],
    includeClassTrace: values["include-class-trace"],
    file: values.file,
    line: parseIntFlag("line", values.line),
    col: parseIntFlag("col", values.col),
    fileInclude: parseRegExpFlag("include", values.include),
    fileExclude: parseRegExpFlag("exclude", values.exclude),
    contextLines: parseIntFlag("context-lines", values["context-lines"]) ?? 0,
    includeLine: values["include-line"],
    excludeColumn: values["exclude-column"],
    json: values.json,
    repo: values.repo,
    noWait: values["no-wait"],
    timeoutMs: parseIntFlag("timeout", values.timeout) ?? DEFAULT_TIMEOUT_MS,
    verbose,
    verboseTags,
  };
}

const HELP_TEXT = `Usage: code-question-agent <query> [flags]

  <query>  Symbol name (default), or a regexp pattern with --regexp.
           Required unless --query-file or --help is given.

What to look up:
  --regexp                  Treat <query> as a name regexp instead of an exact symbol name.
  --query-file <path>       Read <query> from this file instead of the positional argument
                             (its contents trimmed of surrounding whitespace). Mutually
                             exclusive with <query>.
  --file <path>             Disambiguate by declaring file (SymbolQuery only).
  --line <n>, --col <n>     Disambiguate by declaration position, 0-indexed (SymbolQuery only).
  --include <regexp>        Keep only results whose file matches (declaring file, or with
                             --what-refs also each reference's own file).
  --exclude <regexp>        Drop results whose file matches (same scope as --include).

What kind of answer:
  --what-refs               Answer with references to the matching symbol instead of its
                             declaration(s).
  --include-class-trace     Also fetch each resolved symbol's enclosing scope chain.

Output shape:
  --json                    Print the raw Report as JSON instead of the human-readable format.
  --context-lines <n>       Extra source lines to print above/below each match (default 0).
  --include-line            Prefix each source line with its line number (default true).
  --exclude-column          Drop the :col-endCol suffix from a block's header.

Connection:
  --repo <path>             Which repo's daemon to talk to (default: current directory).
  --no-wait                 Skip waiting for cold-start indexing to finish.
  --timeout <ms>            Deadline for indexing/daemon-start waits (default 120000).

Diagnostics:
  -v, --verbose[=tags]      Print progress/diagnostic lines to stderr. A bare -v enables every
                             tag; -v=<tags> (comma-separated, also -vtag1,tag2 or
                             --verbose=tags) limits it to just those. Tags: "scan" (cold-start
                             indexing progress) and "daemon" (daemon spawn/connect lifecycle).
                             With no options, -v at least shows the cold-start scan's progress.

  -h, --help                Print this help and exit.

See docs/cli.md for the full reference.`;

/** Usage text for `--help`/`-h`, mirroring `docs/cli.md`. */
export function formatHelp(): string {
  return HELP_TEXT;
}
