import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lsTool } from "../../src/tools/ls.ts";

describe("lsTool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-ls-"));
    await writeFile(path.join(workspaceDir, "a.ts"), "");
    await writeFile(path.join(workspaceDir, "b.ts"), "");
    await mkdir(path.join(workspaceDir, "sub"));
    await mkdir(path.join(workspaceDir, "node_modules"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("lists files and directories, sorted, with a trailing slash on directories", async () => {
    const result = await lsTool.run({}, { workspaceDir });
    expect(result.split("\n")).toEqual(["a.ts", "b.ts", "sub/"]);
  });

  it("skips ignored directory names", async () => {
    const result = await lsTool.run({}, { workspaceDir });
    expect(result).not.toContain("node_modules");
  });

  it("lists a subdirectory when path is given", async () => {
    await writeFile(path.join(workspaceDir, "sub", "c.ts"), "");
    const result = await lsTool.run({ path: "sub" }, { workspaceDir });
    expect(result).toBe("c.ts");
  });

  it("rejects an absolute path", async () => {
    await expect(lsTool.run({ path: "/etc" }, { workspaceDir })).rejects.toThrow(/absolute/);
  });

  it("rejects a path that escapes the workspace", async () => {
    await expect(lsTool.run({ path: "../" }, { workspaceDir })).rejects.toThrow(/escapes/);
  });
});
