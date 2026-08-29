import { readFile } from "node:fs/promises";
import { type CliOptions } from "./args.ts";

/** Resolves the effective query text: `opts.query`, or the trimmed contents of `opts.queryFile` when given. */
export async function resolveQueryInput(opts: CliOptions): Promise<string> {
  if (opts.queryFile === undefined) return opts.query;
  const content = await readFile(opts.queryFile, "utf8");
  return content.trim();
}
