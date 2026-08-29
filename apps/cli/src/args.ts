import { parseArgs } from "node:util";

export interface CliOptions {
  query: string;
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

/** Parses `argv` (excluding `node`/script) into `CliOptions`. Throws on a missing query or a malformed numeric flag. */
export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
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
    },
  });

  const query = positionals[0];
  if (query === undefined) throw new Error("a query (symbol name or regexp) is required");

  return {
    query,
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
  };
}
