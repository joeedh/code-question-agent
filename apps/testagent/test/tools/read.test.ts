import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../../src/tools/read.ts";

describe("readTool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-read-"));
    await writeFile(path.join(workspaceDir, "file.txt"), "one\ntwo\nthree\nfour\nfive");
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("reads a whole file with 1-indexed line numbers", async () => {
    const result = await readTool.run({ path: "file.txt" }, { workspaceDir, visionCapable: false });
    expect(result).toBe("1: one\n2: two\n3: three\n4: four\n5: five");
  });

  it("honors a startLine/endLine range", async () => {
    const result = await readTool.run(
      { path: "file.txt", startLine: 2, endLine: 3 },
      { workspaceDir, visionCapable: false },
    );
    expect(result).toBe("2: two\n3: three");
  });

  it("rejects an absolute path", async () => {
    await expect(
      readTool.run({ path: "/etc/passwd" }, { workspaceDir, visionCapable: false }),
    ).rejects.toThrow(/absolute/);
  });

  it("rejects a path that escapes the workspace", async () => {
    await expect(
      readTool.run({ path: "../outside.txt" }, { workspaceDir, visionCapable: false }),
    ).rejects.toThrow(/escapes/);
  });
});
