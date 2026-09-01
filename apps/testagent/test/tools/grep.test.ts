import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grepTool } from "../../src/tools/grep.ts";

describe("grepTool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-grep-"));
    await writeFile(path.join(workspaceDir, "a.ts"), "line one\nfindme here\nline three");
    await mkdir(path.join(workspaceDir, "sub"));
    await writeFile(path.join(workspaceDir, "sub", "b.ts"), "nothing\nfindme too\nend");
    await mkdir(path.join(workspaceDir, "node_modules"));
    await writeFile(path.join(workspaceDir, "node_modules", "c.ts"), "findme ignored");
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("finds matches recursively by default", async () => {
    const result = await grepTool.run(
      { pattern: "findme" },
      { workspaceDir, visionCapable: false },
    );
    expect(result).toContain("a.ts:2");
    expect(result).toContain(path.join("sub", "b.ts") + ":2");
  });

  it("skips ignored directories", async () => {
    const result = await grepTool.run(
      { pattern: "findme" },
      { workspaceDir, visionCapable: false },
    );
    expect(result).not.toContain("node_modules");
  });

  it("reports 'no matches' when nothing matches", async () => {
    const result = await grepTool.run(
      { pattern: "nope-not-here" },
      { workspaceDir, visionCapable: false },
    );
    expect(result).toBe("no matches");
  });

  it("includes context lines, clamped to the 25-line cap", async () => {
    const result = await grepTool.run(
      { pattern: "findme", path: "a.ts", contextLines: 100 },
      { workspaceDir, visionCapable: false },
    );
    expect(result).toContain("a.ts:1");
    expect(result).toContain("a.ts:3");
  });

  it("restricts to the given path filter", async () => {
    const result = await grepTool.run(
      { pattern: "findme", path: "sub" },
      { workspaceDir, visionCapable: false },
    );
    expect(result).not.toContain("a.ts:");
  });
});
