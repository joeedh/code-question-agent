import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LspBridge } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import {
  type DocumentSymbol,
  type Location,
  SymbolKind,
} from "vscode-languageserver-protocol/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyOccurrenceKind,
  mapDocumentSymbolsToRows,
  mapReferencesToOccurrences,
  replaceFileIndex,
} from "../src/index-file.ts";
import { openDatabase } from "../src/open.ts";
import { type Database } from "../src/schema.ts";
import { positionOf } from "./position.ts";

const tscPath = process.env.TSC_LSP_PATH;
const fixturesDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "lsp-bridge",
  "test",
  "fixtures",
  "basic",
);
const greeterPath = path.join(fixturesDir, "greeter.ts");
const callerPath = path.join(fixturesDir, "caller.ts");

function symbol(
  name: string,
  kind: SymbolKind = SymbolKind.Function,
  children: DocumentSymbol[] = [],
): DocumentSymbol {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } };
  return { name, kind, range, selectionRange: range, children };
}

describe("mapDocumentSymbolsToRows", () => {
  it("flattens a hierarchy, keeping each child's parent as an index into the flat list", () => {
    const tree = [
      symbol("greet"),
      symbol("Greeter", SymbolKind.Class, [symbol("sayHi", SymbolKind.Method)]),
    ];
    const rows = mapDocumentSymbolsToRows("file:///greeter.ts", tree);

    expect(rows.map((row) => row.name)).toEqual(["greet", "Greeter", "sayHi"]);
    expect(rows[0]?.parentIndex).toBeNull();
    expect(rows[1]?.parentIndex).toBeNull();
    expect(rows[2]?.parentIndex).toBe(1);
  });
});

describe("classifyOccurrenceKind", () => {
  it("classifies a call site", () => {
    expect(classifyOccurrenceKind("  greet(this.greeting)", 7)).toBe("call");
  });

  it("classifies a call site with whitespace before the parenthesis", () => {
    expect(classifyOccurrenceKind("  greet (this.greeting)", 7)).toBe("call");
  });

  it("classifies a plain read", () => {
    expect(classifyOccurrenceKind("  return greet;", 14)).toBe("read");
  });
});

describe("mapReferencesToOccurrences", () => {
  it("attaches the given symbol id and delegates kind classification", () => {
    const locations: Location[] = [
      {
        uri: "file:///a.ts",
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
      },
    ];
    const rows = mapReferencesToOccurrences(42, locations, () => "call");
    expect(rows).toEqual([
      {
        symbol_id: 42,
        file: "file:///a.ts",
        line: 1,
        col: 2,
        end_line: 1,
        end_col: 7,
        kind: "call",
      },
    ]);
  });
});

describe("replaceFileIndex", () => {
  let dir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-index-"));
    db = await openDatabase(path.join(dir, "test.sqlite"));
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a file's symbols, contains edges, and occurrences in one transaction", async () => {
    await replaceFileIndex(db, "file:///greeter.ts", {
      symbols: [
        {
          file: "file:///greeter.ts",
          kind: "5",
          name: "Greeter",
          def_line: 4,
          def_col: 13,
          def_end_line: 4,
          def_end_col: 20,
          parentIndex: null,
        },
        {
          file: "file:///greeter.ts",
          kind: "6",
          name: "sayHi",
          def_line: 11,
          def_col: 2,
          def_end_line: 11,
          def_end_col: 7,
          parentIndex: 0,
        },
      ],
      occurrences: [],
    });

    const symbols = await db.selectFrom("symbols").selectAll().orderBy("id").execute();
    expect(symbols.map((s) => s.name)).toEqual(["Greeter", "sayHi"]);

    const edges = await db.selectFrom("edges").selectAll().execute();
    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("contains");
    expect(edges[0]?.from_id).toBe(symbols[0]?.id);
    expect(edges[0]?.to_id).toBe(symbols[1]?.id);

    // Re-index with a shrunk symbol set: the stale row and its edge must be gone.
    await replaceFileIndex(db, "file:///greeter.ts", {
      symbols: [
        {
          file: "file:///greeter.ts",
          kind: "5",
          name: "Greeter",
          def_line: 4,
          def_col: 13,
          def_end_line: 4,
          def_end_col: 20,
          parentIndex: null,
        },
      ],
      occurrences: [],
    });

    const symbolsAfter = await db.selectFrom("symbols").selectAll().execute();
    expect(symbolsAfter.map((s) => s.name)).toEqual(["Greeter"]);
    const edgesAfter = await db.selectFrom("edges").selectAll().execute();
    expect(edgesAfter).toHaveLength(0);
  });

  it("leaves other files' rows untouched", async () => {
    await replaceFileIndex(db, "file:///a.ts", {
      symbols: [
        {
          file: "file:///a.ts",
          kind: "12",
          name: "fromA",
          def_line: 0,
          def_col: 0,
          def_end_line: 0,
          def_end_col: 5,
          parentIndex: null,
        },
      ],
      occurrences: [],
    });
    await replaceFileIndex(db, "file:///b.ts", {
      symbols: [
        {
          file: "file:///b.ts",
          kind: "12",
          name: "fromB",
          def_line: 0,
          def_col: 0,
          def_end_line: 0,
          def_end_col: 5,
          parentIndex: null,
        },
      ],
      occurrences: [],
    });

    const symbols = await db.selectFrom("symbols").selectAll().orderBy("name").execute();
    expect(symbols.map((s) => s.name)).toEqual(["fromA", "fromB"]);
  });
});

describe.skipIf(!tscPath)("index-file against the real tsc --lsp server", () => {
  let bridge: LspBridge;
  let greeterUri: string;
  let greeterText: string;
  let callerText: string;

  beforeAll(async () => {
    greeterText = await readFile(greeterPath, "utf8");
    callerText = await readFile(callerPath, "utf8");
    bridge = new LspBridge({ tscPath: tscPath!, rootDir: fixturesDir });
    await bridge.initialize();
    greeterUri = await bridge.openDocument(greeterPath, greeterText);
    await bridge.openDocument(callerPath, callerText);
  }, 30_000);

  afterAll(async () => {
    await bridge.dispose();
  });

  it("maps a real documentSymbol response into rows the DB accepts", async () => {
    const symbols = (await bridge.documentSymbols(greeterUri)) as DocumentSymbol[];
    const rows = mapDocumentSymbolsToRows(greeterUri, symbols);

    expect(rows.map((r) => r.name).sort()).toEqual(
      ["Greeter", "constructor", "greet", "greeting", "sayHi"].sort(),
    );
    const sayHi = rows.find((r) => r.name === "sayHi");
    const greeter = rows.find((r) => r.name === "Greeter");
    const greeterIndex = rows.indexOf(greeter!);
    expect(sayHi?.parentIndex).toBe(greeterIndex);

    const dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-index-real-"));
    const db = await openDatabase(path.join(dir, "test.sqlite"));
    try {
      await replaceFileIndex(db, greeterUri, { symbols: rows, occurrences: [] });
      const stored = await db.selectFrom("symbols").selectAll().execute();
      expect(stored.map((s) => s.name).sort()).toEqual(
        ["Greeter", "constructor", "greet", "greeting", "sayHi"].sort(),
      );
    } finally {
      await db.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps a real references response into occurrences, classifying call sites", async () => {
    const declPosition = positionOf(greeterText, "greet", 0);
    const locations = (await bridge.references(greeterUri, declPosition, false)) ?? [];
    const rows = mapReferencesToOccurrences(1, locations, (location) => {
      const text = location.uri === greeterUri ? greeterText : callerText;
      const line = text.split("\n")[location.range.start.line] ?? "";
      return classifyOccurrenceKind(line, location.range.end.character);
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.symbol_id === 1)).toBe(true);
    expect(rows.some((row) => row.kind === "call")).toBe(true);
  });
});
