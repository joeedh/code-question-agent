import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, type Database } from "@code-question-agent/db";
import { toFileUri } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSymbols, symbolLookup, whatRefs } from "../src/query.ts";

describe("file-scoped queries (--include/--exclude)", () => {
  let dir: string;
  let db: Kysely<Database>;
  let srcUri: string;
  let testUri: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-query-"));
    db = await openDatabase(path.join(dir, "test.sqlite"));
    srcUri = toFileUri(path.join(dir, "src", "greet.ts"));
    testUri = toFileUri(path.join(dir, "test", "greet.ts"));
    await db
      .insertInto("symbols")
      .values([
        {
          file: srcUri,
          kind: "12",
          name: "greet",
          def_line: 0,
          def_col: 0,
          def_end_line: 0,
          def_end_col: 5,
        },
        {
          file: testUri,
          kind: "12",
          name: "greet",
          def_line: 0,
          def_col: 0,
          def_end_line: 0,
          def_end_col: 5,
        },
      ])
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("with no filter, resolves both same-named symbols", async () => {
    const symbols = await resolveSymbols(db, { type: "symbol-query", symbol: "greet" });
    expect(symbols).toHaveLength(2);
  });

  it("fileInclude narrows to the declaring file that matches", async () => {
    const symbols = await resolveSymbols(db, {
      type: "symbol-query",
      symbol: "greet",
      fileInclude: "[\\\\/]src[\\\\/]",
    });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.file).toBe(srcUri);
  });

  it("fileExclude drops the declaring file that matches", async () => {
    const symbols = await resolveSymbols(db, {
      type: "symbol-query",
      symbol: "greet",
      fileExclude: "[\\\\/]test[\\\\/]",
    });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.file).toBe(srcUri);
  });

  it("fileInclude and fileExclude combine", async () => {
    const symbols = await resolveSymbols(db, {
      type: "symbol-query",
      symbol: "greet",
      fileInclude: "greet\\.ts$",
      fileExclude: "[\\\\/]test[\\\\/]",
    });
    expect(symbols).toHaveLength(1);
    expect(symbols[0]?.file).toBe(srcUri);
  });

  it("a filter matching nothing empties the symbol-info result", async () => {
    const report = await symbolLookup(db, {
      type: "symbol-query",
      symbol: "greet",
      fileInclude: "nowhere",
    });
    expect(report.symbols).toEqual([]);
  });

  it("what-refs throws when the file filter eliminates the only match", async () => {
    await expect(
      whatRefs(db, { type: "symbol-query", symbol: "greet", fileInclude: "nowhere" }),
    ).rejects.toThrow(/no symbol matched/);
  });

  it("what-refs also filters each reference by its own file, not just the declaring symbol's", async () => {
    const symbolRow = await db
      .selectFrom("symbols")
      .select("id")
      .where("file", "=", srcUri)
      .executeTakeFirstOrThrow();
    const symbolId = symbolRow.id;
    await db
      .insertInto("occurrences")
      .values([
        { symbol_id: symbolId, file: srcUri, line: 5, col: 0, end_line: 5, end_col: 5, kind: "call" },
        { symbol_id: symbolId, file: testUri, line: 9, col: 0, end_line: 9, end_col: 5, kind: "call" },
      ])
      .execute();

    const report = await whatRefs(db, {
      type: "symbol-query",
      symbol: "greet",
      file: srcUri,
      fileExclude: "[\\\\/]test[\\\\/]",
    });
    expect(report.references).toHaveLength(1);
    expect(report.references[0]?.file).toBe(srcUri);
  });
});
