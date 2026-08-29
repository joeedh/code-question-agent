import path from "node:path";
import { type EnclosingScope, type Location } from "@code-question-agent/core";
import { fromFileUri } from "@code-question-agent/lsp-bridge";
import { type CliOptions } from "./args.ts";
import { resolvedSymbolsOf, type QueryResult } from "./query.ts";
import { type SnippetReader } from "./snippet.ts";

function displayPath(file: string): string {
  const fsPath = file.startsWith("file://") ? fromFileUri(file) : file;
  return path.relative(process.cwd(), fsPath);
}

function formatTraceLine(trace: EnclosingScope | undefined): string | undefined {
  if (!trace) return undefined;
  return trace.trace.length === 0 ? "  inside (script root)" : `  inside ${trace.trace.map((s) => s.name).join(".")}`;
}

/** `Location` carries 0-indexed LSP line/column numbers; the human-readable format shows the conventional 1-indexed ones. */
function displayLine(zeroIndexedLine: number): number {
  return zeroIndexedLine + 1;
}

function formatHeader(location: Location, label: string, opts: CliOptions): string {
  const parts = [displayPath(location.file)];
  if (opts.includeLine) {
    const startLine = displayLine(location.line);
    const endLine = displayLine(location.endLine);
    const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    parts.push(opts.excludeColumn ? lineRange : `${lineRange}:${location.col + 1}-${location.endCol + 1}`);
  }
  parts.push(label);
  return `== ${parts.join(":")} ==`;
}

async function formatBlock(
  location: Location,
  label: string,
  opts: CliOptions,
  snippetReader: SnippetReader,
  traceLine: string | undefined,
): Promise<string> {
  const lines = [formatHeader(location, label, opts)];
  if (traceLine) lines.push(traceLine);

  const { startLine, lines: snippetLines } = await snippetReader.read(location, opts.contextLines);
  snippetLines.forEach((text, i) => {
    lines.push(opts.includeLine ? `${displayLine(startLine + i)}: ${text}` : text);
  });

  return lines.join("\n");
}

export async function formatHuman(result: QueryResult, opts: CliOptions, snippetReader: SnippetReader): Promise<string> {
  const { report, traces } = result;
  const blocks: Promise<string>[] = [];

  if (report.type === "symbol-info") {
    for (const symbol of report.symbols) {
      blocks.push(formatBlock(symbol, `definition:${symbol.kind}`, opts, snippetReader, formatTraceLine(traces.get(symbol.id))));
    }
    if (report.symbols.length === 0) return "no matching symbols";
  } else {
    const traceLine = formatTraceLine(traces.get(report.symbol.id));
    for (const occurrence of report.references) {
      blocks.push(formatBlock(occurrence, `ref:${occurrence.kind}`, opts, snippetReader, traceLine));
    }
    if (report.references.length === 0) return `no references found for ${report.symbol.name}`;
  }

  return (await Promise.all(blocks)).join("\n\n");
}

export function formatJson(result: QueryResult): string {
  const traces: Record<number, EnclosingScope> = {};
  for (const symbol of resolvedSymbolsOf(result.report)) {
    const trace = result.traces.get(symbol.id);
    if (trace) traces[symbol.id] = trace;
  }

  return JSON.stringify({ ...result.report, traces }, null, 2);
}
