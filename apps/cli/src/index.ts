#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { formatHelp, formatLlmHelp, parseCliArgs } from "./args.ts";
import { ensureDaemon, waitForIndexing } from "./connection.ts";
import { formatHuman, formatJson } from "./format.ts";
import { resolveQueryInput } from "./queryInput.ts";
import { runQuery } from "./query.ts";
import { createSnippetReader } from "./snippet.ts";

export { formatHelp, formatLlmHelp, parseCliArgs, type CliOptions } from "./args.ts";
export { ensureDaemon, waitForIndexing } from "./connection.ts";
export { formatHuman, formatJson } from "./format.ts";
export { resolveQueryInput } from "./queryInput.ts";
export { buildQuery, resolvedSymbolsOf, runQuery, type QueryResult } from "./query.ts";
export { createSnippetReader, type SnippetReader } from "./snippet.ts";
export { createVerboseLogger, type VerboseLogger } from "./verbose.ts";

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.llmHelp) {
    console.log(formatLlmHelp());
    return;
  }
  if (opts.help) {
    console.log(formatHelp());
    return;
  }
  const resolvedOpts = { ...opts, query: await resolveQueryInput(opts) };
  const repoRoot = resolvedOpts.repo ?? process.cwd();

  const { connection } = await ensureDaemon(repoRoot, resolvedOpts);
  try {
    await waitForIndexing(connection, resolvedOpts);
    const result = await runQuery(connection, resolvedOpts);
    const output = resolvedOpts.json
      ? formatJson(result)
      : await formatHuman(result, resolvedOpts, createSnippetReader());
    console.log(output);
  } finally {
    connection.dispose();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
