import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Location } from "@code-question-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnippetReader } from "../src/snippet.ts";

/** `line`/`endLine` are 0-indexed, matching `Location`'s LSP-derived convention. */
function locationAt(file: string, line: number, endLine = line): Location {
  return { file, line, col: 0, endLine, endCol: 0 };
}

describe("createSnippetReader", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cli-snippet-"));
    filePath = path.join(dir, "five-lines.txt");
    await writeFile(filePath, ["one", "two", "three", "four", "five"].join("\n"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns just the target line with zero context", async () => {
    const reader = createSnippetReader();
    const { startLine, lines } = await reader.read(locationAt(filePath, 2), 0);
    expect(startLine).toBe(2);
    expect(lines).toEqual(["three"]);
  });

  it("widens the window symmetrically for a positive context", async () => {
    const reader = createSnippetReader();
    const { startLine, lines } = await reader.read(locationAt(filePath, 2), 1);
    expect(startLine).toBe(1);
    expect(lines).toEqual(["two", "three", "four"]);
  });

  it("clamps at the start of the file", async () => {
    const reader = createSnippetReader();
    const { startLine, lines } = await reader.read(locationAt(filePath, 0), 3);
    expect(startLine).toBe(0);
    expect(lines).toEqual(["one", "two", "three", "four"]);
  });

  it("clamps at the end of the file", async () => {
    const reader = createSnippetReader();
    const { startLine, lines } = await reader.read(locationAt(filePath, 4), 3);
    expect(startLine).toBe(1);
    expect(lines).toEqual(["two", "three", "four", "five"]);
  });

  it("caches a file's lines across repeated reads", async () => {
    const reader = createSnippetReader();
    await reader.read(locationAt(filePath, 0), 0);
    await writeFile(filePath, "changed");
    const { lines } = await reader.read(locationAt(filePath, 0), 0);
    expect(lines).toEqual(["one"]);
  });
});
