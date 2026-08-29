#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "./args.ts";
import { ensureDaemon, waitForIndexing } from "./connection.ts";
import { formatHuman, formatJson } from "./format.ts";
import { runQuery } from "./query.ts";
import { createSnippetReader } from "./snippet.ts";

export { parseCliArgs, type CliOptions } from "./args.ts";
export { ensureDaemon, waitForIndexing } from "./connection.ts";
export { formatHuman, formatJson } from "./format.ts";
export { buildQuery, resolvedSymbolsOf, runQuery, type QueryResult } from "./query.ts";
export { createSnippetReader, type SnippetReader } from "./snippet.ts";

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const repoRoot = opts.repo ?? process.cwd();

  const { connection } = await ensureDaemon(repoRoot, opts);
  try {
    await waitForIndexing(connection, opts);
    const result = await runQuery(connection, opts);
    const output = opts.json
      ? formatJson(result)
      : await formatHuman(result, opts, createSnippetReader());
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
