import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointPath,
  evictCheckpoints,
  findClosestCheckpoint,
  getSubmoduleDrift,
  getTreeHash,
  listCheckpoints,
} from "../src/checkpoint.ts";

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout.trim();
}

async function initRepo(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "--quiet"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "Test"]);
}

async function commit(repoDir: string, message: string): Promise<string> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "--quiet", "-m", message]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("checkpoint identity", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-checkpoint-"));
    await initRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("computes HEAD's tree hash, matching `git rev-parse HEAD^{tree}` directly", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "one");
    await commit(repoDir, "first");

    const treeHash = await getTreeHash(repoDir);
    const expected = await git(repoDir, ["rev-parse", "HEAD^{tree}"]);
    expect(treeHash).toBe(expected);
    expect(treeHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gives two commits with identical content the same tree hash", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "same");
    await commit(repoDir, "first");
    const firstTree = await getTreeHash(repoDir);

    await writeFile(path.join(repoDir, "b.txt"), "unrelated");
    await commit(repoDir, "second");
    await git(repoDir, ["rm", "--quiet", "b.txt"]);
    await commit(repoDir, "revert");
    const thirdTree = await getTreeHash(repoDir);

    expect(thirdTree).toBe(firstTree);
  });

  it("lists checkpoint tree hashes from a directory of <tree-hash>.sqlite files", async () => {
    const checkpointsDir = path.join(repoDir, "checkpoints");
    await mkdir(checkpointsDir);
    await writeFile(path.join(checkpointsDir, "abc123.sqlite"), "");
    await writeFile(path.join(checkpointsDir, "def456.sqlite"), "");
    await writeFile(path.join(checkpointsDir, "notes.txt"), "");

    const hashes = await listCheckpoints(checkpointsDir);
    expect(hashes.sort()).toEqual(["abc123", "def456"]);
    expect(checkpointPath(checkpointsDir, "abc123")).toBe(path.join(checkpointsDir, "abc123.sqlite"));
  });

  it("returns an empty list for a checkpoints directory that doesn't exist yet", async () => {
    const hashes = await listCheckpoints(path.join(repoDir, "no-such-dir"));
    expect(hashes).toEqual([]);
  });

  it("picks the candidate with the smaller diff as the closest checkpoint", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "v1");
    await commit(repoDir, "base");
    const baseTree = await getTreeHash(repoDir);

    // A small, one-file change from base.
    await writeFile(path.join(repoDir, "a.txt"), "v2");
    await commit(repoDir, "small change");
    const closeTree = await getTreeHash(repoDir);

    // Two more files added on top of the small change — a.txt itself doesn't move
    // again, so this is a bigger diff from `base` (3 changed files) than from
    // `close` (2 added files) — `close` is genuinely nearer.
    await writeFile(path.join(repoDir, "b.txt"), "new");
    await writeFile(path.join(repoDir, "c.txt"), "new");
    await commit(repoDir, "add more files");
    const targetTree = await getTreeHash(repoDir);

    const best = await findClosestCheckpoint(repoDir, targetTree, [baseTree, closeTree]);
    expect(best?.treeHash).toBe(closeTree);
  });

  it("reports no submodule drift when none exist", async () => {
    const drift = await getSubmoduleDrift(repoDir);
    expect(drift).toEqual([]);
  });

  it("detects a submodule checked out off its recorded gitlink", async () => {
    const submoduleDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-submodule-"));
    try {
      await initRepo(submoduleDir);
      await writeFile(path.join(submoduleDir, "s.txt"), "one");
      const firstCommit = await commit(submoduleDir, "first");
      await writeFile(path.join(submoduleDir, "s.txt"), "two");
      await commit(submoduleDir, "second");

      await git(repoDir, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleDir.replace(/\\/g, "/"),
        "sub",
      ]);
      await commit(repoDir, "add submodule");

      const clean = await getSubmoduleDrift(repoDir);
      expect(clean).toEqual([]);

      // Move the submodule's working copy off the commit recorded in the parent's index.
      await git(path.join(repoDir, "sub"), ["checkout", "--quiet", firstCommit]);

      const drifted = await getSubmoduleDrift(repoDir);
      expect(drifted).toHaveLength(1);
      expect(drifted[0]?.path).toBe("sub");
      expect(drifted[0]?.checkedOutCommit.startsWith(firstCommit.slice(0, 7))).toBe(true);
    } finally {
      await rm(submoduleDir, { recursive: true, force: true });
    }
  });
});

describe("evictCheckpoints", () => {
  let checkpointsDir: string;

  beforeEach(async () => {
    checkpointsDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-evict-"));
  });

  afterEach(async () => {
    await rm(checkpointsDir, { recursive: true, force: true });
  });

  async function makeCheckpoint(treeHash: string, sizeBytes: number, ageMs: number): Promise<void> {
    const filePath = checkpointPath(checkpointsDir, treeHash);
    await writeFile(filePath, Buffer.alloc(sizeBytes));
    const mtime = new Date(Date.now() - ageMs);
    await utimes(filePath, mtime, mtime);
  }

  it("evicts oldest-first once the total exceeds the budget", async () => {
    await makeCheckpoint("oldest", 100, 30_000);
    await makeCheckpoint("middle", 100, 20_000);
    await makeCheckpoint("newest", 100, 10_000);

    const evicted = await evictCheckpoints(checkpointsDir, 250, new Set());

    expect(evicted).toEqual(["oldest"]);
    expect((await listCheckpoints(checkpointsDir)).sort()).toEqual(["middle", "newest"]);
  });

  it("never evicts a protected tree hash, even the oldest", async () => {
    await makeCheckpoint("oldest-protected", 100, 30_000);
    await makeCheckpoint("middle", 100, 20_000);
    await makeCheckpoint("newest", 100, 10_000);

    const evicted = await evictCheckpoints(checkpointsDir, 250, new Set(["oldest-protected"]));

    expect(evicted).toEqual(["middle"]);
    expect((await listCheckpoints(checkpointsDir)).sort()).toEqual(["newest", "oldest-protected"]);
  });

  it("evicts nothing when already under budget", async () => {
    await makeCheckpoint("a", 100, 10_000);
    const evicted = await evictCheckpoints(checkpointsDir, 1_000, new Set());
    expect(evicted).toEqual([]);
    expect(await listCheckpoints(checkpointsDir)).toEqual(["a"]);
  });
});
