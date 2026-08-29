import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Database, openDatabase } from "@code-question-agent/db";
import { LspBridge } from "@code-question-agent/lsp-bridge";
import { type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIndexer, type Indexer } from "../src/indexer.ts";
import { enclosingScope, symbolLookup, whatRefs } from "../src/query.ts";

const tscPath = process.env.TSC_LSP_PATH;
const fixturesDir = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "lsp-bridge",
  "test",
  "fixtures",
  "basic",
);
const greeterPath = path.join(fixturesDir, "greeter.ts");
const callerPath = path.join(fixturesDir, "caller.ts");

describe.skipIf(!tscPath)("indexer + query, end to end against the real tsc --lsp server", () => {
  let dir: string;
  let db: Kysely<Database>;
  let bridge: LspBridge;
  let indexer: Indexer;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-indexer-e2e-"));
    db = await openDatabase(path.join(dir, "test.sqlite"));
    bridge = new LspBridge({ tscPath: tscPath!, rootDir: fixturesDir });
    await bridge.initialize();
    indexer = createIndexer(db, bridge);

    await indexer.indexFile(greeterPath);
    await indexer.indexFile(callerPath);
    await indexer.waitForIdle();
  }, 30_000);

  afterAll(async () => {
    await bridge.dispose();
    await db.destroy();
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("makes greeter.ts's function declaration queryable by exact name", async () => {
    // caller.ts imports `greet`, and hierarchical documentSymbol reports that binding too, so
    // an unscoped exact-name lookup can return more than one row — the declaration itself is
    // what this test cares about.
    const report = await symbolLookup(db, { type: "symbol-query", symbol: "greet" });
    const declaration = report.symbols.find((s) => s.file.endsWith("greeter.ts"));
    expect(declaration?.name).toBe("greet");
  });

  it("answers a regexp search across symbols", async () => {
    const report = await symbolLookup(db, { type: "search-query", query: "^Greeter$", useRegExp: true });
    expect(report.symbols.length).toBeGreaterThan(0);
    expect(report.symbols.every((s) => s.name === "Greeter")).toBe(true);
    expect(report.symbols.some((s) => s.file.endsWith("greeter.ts"))).toBe(true);
  });

  it("fills in occurrences from the background queue, including the cross-file call", async () => {
    const report = await whatRefs(db, { type: "symbol-query", symbol: "greet" });
    expect(report.references.length).toBeGreaterThan(0);
    expect(report.references.some((r) => r.kind === "call")).toBe(true);
    const files = new Set(report.references.map((r) => path.basename(r.file)));
    expect(files.has("caller.ts")).toBe(true);
  });

  it("walks the containment chain for a method inside a class", async () => {
    const report = await enclosingScope(db, { type: "symbol-query", symbol: "sayHi" });
    expect(report.trace.map((s) => s.name)).toEqual(["Greeter"]);
  });

  it("removeFile clears a file's symbols and occurrences", async () => {
    await indexer.removeFile(greeterPath);
    const remaining = await db.selectFrom("symbols").selectAll().where("file", "like", "%greeter.ts").execute();
    expect(remaining).toEqual([]);

    // Restore for any test file order that might run after this one.
    await indexer.indexFile(greeterPath);
    await indexer.waitForIdle();
  });
});
