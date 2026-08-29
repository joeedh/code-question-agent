import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRepoPaths } from "../src/repo.ts";

describe("resolveRepoPaths", () => {
  let repoA: string;
  let repoB: string;
  let baseDataDir: string;

  beforeEach(async () => {
    repoA = await mkdtemp(path.join(tmpdir(), "code-question-agent-repo-a-"));
    repoB = await mkdtemp(path.join(tmpdir(), "code-question-agent-repo-b-"));
    baseDataDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-data-"));
  });

  afterEach(async () => {
    await Promise.all(
      [repoA, repoB, baseDataDir].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("derives the same id and paths for the same repo root every time", async () => {
    const first = await resolveRepoPaths(repoA, baseDataDir);
    const second = await resolveRepoPaths(repoA, baseDataDir);
    expect(second).toEqual(first);
  });

  it("derives different ids for different repo roots", async () => {
    const a = await resolveRepoPaths(repoA, baseDataDir);
    const b = await resolveRepoPaths(repoB, baseDataDir);
    expect(a.repoId).not.toBe(b.repoId);
    expect(a.liveDbPath).not.toBe(b.liveDbPath);
    expect(a.ipcAddress).not.toBe(b.ipcAddress);
  });

  it("nests the live DB, checkpoints dir, and metadata file under the data dir", async () => {
    const paths = await resolveRepoPaths(repoA, baseDataDir);
    expect(paths.liveDbPath).toBe(path.join(paths.dataDir, "live.sqlite"));
    expect(paths.checkpointsDir).toBe(path.join(paths.dataDir, "checkpoints"));
    expect(paths.metadataPath).toBe(path.join(paths.dataDir, "daemon.json"));
    expect(paths.dataDir.startsWith(baseDataDir)).toBe(true);
  });

  it("never picks a TCP address — a named pipe on win32, a socket path elsewhere", async () => {
    const paths = await resolveRepoPaths(repoA, baseDataDir);
    if (process.platform === "win32") {
      expect(paths.ipcAddress.startsWith("\\\\.\\pipe\\")).toBe(true);
    } else {
      expect(path.isAbsolute(paths.ipcAddress)).toBe(true);
      expect(paths.ipcAddress.endsWith(".sock")).toBe(true);
    }
  });
});
