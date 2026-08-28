import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type DocumentSymbol,
  ErrorCodes,
  type Location,
  type LocationLink,
  ResponseError,
} from "vscode-languageserver-protocol/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspBridge } from "../src/client.ts";
import { positionOf } from "./position.ts";

const tscPath = process.env.TSC_LSP_PATH;
const fixturesDir = path.join(import.meta.dirname, "fixtures", "basic");
const greeterPath = path.join(fixturesDir, "greeter.ts");
const callerPath = path.join(fixturesDir, "caller.ts");
const greeterText = readFileSync(greeterPath, "utf8");
const callerText = readFileSync(callerPath, "utf8");

function isLocationLink(value: Location | LocationLink): value is LocationLink {
  return "targetUri" in value;
}

/**
 * `initialize` advertised `definition.linkSupport`, so `textDocument/definition`
 * answers with `LocationLink[]` (`targetUri`/`targetSelectionRange`) rather than
 * the plain `Location[]` shape `textDocument/references` still uses.
 */
function toLocations(result: Location | Location[] | LocationLink[] | null): Location[] {
  if (result === null) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((entry) =>
    isLocationLink(entry) ? { uri: entry.targetUri, range: entry.targetSelectionRange } : entry,
  );
}

describe.skipIf(!tscPath)("LspBridge against the real tsc --lsp server", () => {
  let bridge: LspBridge;
  let greeterUri: string;
  let callerUri: string;

  beforeAll(async () => {
    bridge = new LspBridge({ tscPath: tscPath!, rootDir: fixturesDir });
    await bridge.initialize();
    greeterUri = await bridge.openDocument(greeterPath, greeterText);
    callerUri = await bridge.openDocument(callerPath, callerText);
  }, 30_000);

  afterAll(async () => {
    await bridge.dispose();
  });

  it("reports definition/references/hover/documentSymbol capabilities", () => {
    const capabilities = bridge.getCapabilities();
    expect(capabilities.definitionProvider).toBeTruthy();
    expect(capabilities.referencesProvider).toBeTruthy();
    expect(capabilities.hoverProvider).toBeTruthy();
    expect(capabilities.documentSymbolProvider).toBeTruthy();
  });

  it("resolves a function definition from its call site", async () => {
    const callPosition = positionOf(callerText, "greet(", 0);
    const result = await bridge.definition(callerUri, callPosition);
    const locations = toLocations(result);
    expect(locations).toHaveLength(1);
    expect(locations[0]?.uri).toBe(greeterUri);
    expect(locations[0]?.range.start.line).toBe(0);
  });

  it("resolves a method definition from its call site", async () => {
    const callPosition = positionOf(callerText, "sayHi()");
    const result = await bridge.definition(callerUri, callPosition);
    const locations = toLocations(result);
    expect(locations).toHaveLength(1);
    expect(locations[0]?.uri).toBe(greeterUri);
  });

  it("finds every reference to a function, including the cross-file import", async () => {
    const declPosition = positionOf(greeterText, "greet", 0);
    const result = await bridge.references(greeterUri, declPosition, true);
    expect(result).not.toBeNull();
    const uris = (result ?? []).map((location) => location.uri).sort();
    // greeter.ts: the declaration plus the call inside sayHi(). caller.ts: the
    // import specifier plus the call site.
    expect(uris).toEqual([callerUri, callerUri, greeterUri, greeterUri].sort());
  });

  it("returns type info on hover", async () => {
    const callPosition = positionOf(callerText, "greet(", 0);
    const hover = await bridge.hover(callerUri, callPosition);
    expect(hover).not.toBeNull();
    const text = JSON.stringify(hover?.contents);
    expect(text).toContain("greet");
    expect(text).toContain("string");
  });

  it("lists both the function and the class via documentSymbol", async () => {
    const symbols = (await bridge.documentSymbols(greeterUri)) as DocumentSymbol[] | null;
    expect(symbols).not.toBeNull();
    const names = (symbols ?? []).map((symbol) => symbol.name).sort();
    expect(names).toEqual(["Greeter", "greet"]);
  });

  it("reflects a didChange edit immediately, before the document is saved", async () => {
    const withExtraFunction = `${greeterText}\nexport function farewell(name: string): string {\n  return name;\n}\n`;
    await bridge.changeDocument(greeterUri, withExtraFunction);
    try {
      const symbols = (await bridge.documentSymbols(greeterUri)) as DocumentSymbol[] | null;
      const names = (symbols ?? []).map((symbol) => symbol.name).sort();
      expect(names).toEqual(["Greeter", "farewell", "greet"]);
    } finally {
      await bridge.changeDocument(greeterUri, greeterText);
    }
  });

  it("does not pick up an on-disk edit to an open document without didChange", async () => {
    const onDiskEdit = `${greeterText}\nexport function onlyOnDisk(): void {}\n`;
    writeFileSync(greeterPath, onDiskEdit, "utf8");
    try {
      const symbols = (await bridge.documentSymbols(greeterUri)) as DocumentSymbol[] | null;
      const names = (symbols ?? []).map((symbol) => symbol.name).sort();
      expect(names).toEqual(["Greeter", "greet"]);
    } finally {
      writeFileSync(greeterPath, greeterText, "utf8");
    }
  });

  it("returns a null hover for a position past the end of the file", async () => {
    const hover = await bridge.hover(greeterUri, { line: 9_999, character: 0 });
    expect(hover).toBeNull();
  });

  // The server answers an unregistered method with InvalidRequest (-32600), not
  // the JSON-RPC-conventional MethodNotFound (-32601).
  it("rejects an unknown request method with a JSON-RPC InvalidRequest error", async () => {
    let caught: unknown;
    try {
      await bridge.sendRawRequest("textDocument/notARealMethod", {
        textDocument: { uri: greeterUri },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResponseError);
    expect((caught as ResponseError).code).toBe(ErrorCodes.InvalidRequest);
  });
});

describe.skipIf(tscPath)("LspBridge exploratory tests", () => {
  it("are skipped without TSC_LSP_PATH pointing at a built tsc.exe", () => {
    expect(tscPath).toBeFalsy();
  });
});
