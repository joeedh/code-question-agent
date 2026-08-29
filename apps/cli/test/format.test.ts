import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type EnclosingScope,
  type ResolvedSymbol,
  type SymbolInfo,
  type WhatRefs,
} from "@code-question-agent/core";
import { toFileUri } from "@code-question-agent/lsp-bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliOptions } from "../src/args.ts";
import { formatHuman, formatJson } from "../src/format.ts";
import { type QueryResult } from "../src/query.ts";
import { createSnippetReader } from "../src/snippet.ts";

function baseOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    help: false,
    llmHelp: false,
    query: "greet",
    regexp: false,
    whatRefs: false,
    includeClassTrace: false,
    contextLines: 0,
    includeLine: true,
    excludeColumn: false,
    json: false,
    noWait: false,
    timeoutMs: 1000,
    verbose: false,
    ...overrides,
  };
}

describe("format", () => {
  let dir: string;
  let uri: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cli-format-"));
    const filePath = path.join(dir, "greeter.ts");
    await writeFile(
      filePath,
      ["export function greet(name: string) {", "  return `hi ${name}`;", "}"].join("\n"),
    );
    uri = toFileUri(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // `line`/`col` are 0-indexed (LSP convention); the human formatter displays them as 1-indexed.
  function symbolInfoReport(): SymbolInfo {
    const symbol: ResolvedSymbol = {
      id: 1,
      name: "greet",
      kind: "12",
      file: uri,
      line: 0,
      col: 0,
      endLine: 0,
      endCol: 5,
    };
    return {
      type: "symbol-info",
      id: "r1",
      title: "Symbol lookup",
      content: "",
      query: { type: "symbol-query", symbol: "greet" },
      info: "",
      symbols: [symbol],
    };
  }

  function whatRefsReport(): WhatRefs {
    const symbol: ResolvedSymbol = {
      id: 1,
      name: "greet",
      kind: "12",
      file: uri,
      line: 0,
      col: 0,
      endLine: 0,
      endCol: 5,
    };
    return {
      type: "what-refs",
      id: "r2",
      title: "References to greet",
      content: "",
      query: { type: "symbol-query", symbol: "greet" },
      symbol,
      references: [{ file: uri, line: 1, col: 9, endLine: 1, endCol: 14, kind: "call" }],
    };
  }

  it("formatHuman renders a definition header and its source line", async () => {
    const result: QueryResult = { report: symbolInfoReport(), traces: new Map() };
    const output = await formatHuman(result, baseOpts(), createSnippetReader());
    expect(output).toContain("greeter.ts:1:1-6:definition:12");
    expect(output).toContain("1: export function greet(name: string) {");
  });

  it("formatHuman renders a what-refs occurrence with its kind", async () => {
    const result: QueryResult = { report: whatRefsReport(), traces: new Map() };
    const output = await formatHuman(result, baseOpts({ whatRefs: true }), createSnippetReader());
    expect(output).toContain("ref:call");
    expect(output).toContain("return `hi ${name}`;");
  });

  it("omits the column range when --exclude-column is set", async () => {
    const result: QueryResult = { report: symbolInfoReport(), traces: new Map() };
    const output = await formatHuman(
      result,
      baseOpts({ excludeColumn: true }),
      createSnippetReader(),
    );
    expect(output).toContain("greeter.ts:1:definition:12");
    expect(output).not.toContain("1:1-6");
  });

  it("drops line numbers entirely when --include-line is false", async () => {
    const result: QueryResult = { report: symbolInfoReport(), traces: new Map() };
    const output = await formatHuman(
      result,
      baseOpts({ includeLine: false }),
      createSnippetReader(),
    );
    expect(output).toContain("greeter.ts:definition:12");
    expect(output).toContain("export function greet(name: string) {");
    expect(output).not.toContain("1: export function greet");
  });

  it("prints the enclosing-scope trace when one was fetched, and the script-root marker when it's empty", async () => {
    const report = symbolInfoReport();
    const trace: EnclosingScope = {
      type: "enclosing-scope",
      id: "r3",
      title: "Enclosing scope of greet",
      content: "(script root)",
      query: report.query,
      symbol: report.symbols[0]!,
      trace: [],
    };
    const result: QueryResult = { report, traces: new Map([[1, trace]]) };
    const output = await formatHuman(
      result,
      baseOpts({ includeClassTrace: true }),
      createSnippetReader(),
    );
    expect(output).toContain("inside (script root)");
  });

  it("reports no matches instead of an empty block list", async () => {
    const report: SymbolInfo = { ...symbolInfoReport(), symbols: [] };
    const output = await formatHuman(
      { report, traces: new Map() },
      baseOpts(),
      createSnippetReader(),
    );
    expect(output).toBe("no matching symbols");
  });

  it("formatJson round-trips and keys traces by resolved-symbol id", () => {
    const report = symbolInfoReport();
    const trace: EnclosingScope = {
      type: "enclosing-scope",
      id: "r3",
      title: "t",
      content: "",
      query: report.query,
      symbol: report.symbols[0]!,
      trace: [],
    };
    const json = formatJson({ report, traces: new Map([[1, trace]]) });
    const parsed = JSON.parse(json) as SymbolInfo & { traces: Record<string, EnclosingScope> };
    expect(parsed.type).toBe("symbol-info");
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.traces["1"]?.type).toBe("enclosing-scope");
  });
});
