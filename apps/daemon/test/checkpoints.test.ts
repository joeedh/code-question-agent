import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { checkpointPath, listCheckpoints, openDatabase } from "@code-question-agent/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointManager } from "../src/checkpoints.ts";

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

async function commit(repoDir: string, message: string): Promise<void> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "--quiet", "-m", message]);
}

describe("checkpoint manager", () => {
  let repoDir: string;
  let dataDir: string;
  let checkpointsDir: string;
  let liveDbPath: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cpmgr-repo-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cpmgr-data-"));
    checkpointsDir = path.join(dataDir, "checkpoints");
    liveDbPath = path.join(dataDir, "live.sqlite");
    await mkdir(checkpointsDir, { recursive: true });
    await initRepo(repoDir);
  });

  afterEach(async () => {
    await Promise.all([repoDir, dataDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("promoteClosest returns null and does nothing when there are no checkpoints", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "one");
    await commit(repoDir, "first");

    const manager = createCheckpointManager({ repoRoot: repoDir, checkpointsDir, liveDbPath });
    const promoted = await manager.promoteClosest();
    expect(promoted).toBeNull();
  });

  it("captureCurrent writes a checkpoint file readable as a real database", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "one");
    await commit(repoDir, "first");
    const treeHash = await git(repoDir, ["rev-parse", "HEAD^{tree}"]);

    const db = await openDatabase(liveDbPath);
    await db
      .insertInto("symbols")
      .values({
        file: "file:///a.ts",
        kind: "12",
        name: "captured",
        def_line: 0,
        def_col: 0,
        def_end_line: 0,
        def_end_col: 5,
      })
      .execute();

    const manager = createCheckpointManager({ repoRoot: repoDir, checkpointsDir, liveDbPath });
    await manager.captureCurrent();
    await db.destroy();

    const checkpoints = await listCheckpoints(checkpointsDir);
    expect(checkpoints).toEqual([treeHash]);

    const restored = await openDatabase(checkpointPath(checkpointsDir, treeHash));
    try {
      const rows = await restored.selectFrom("symbols").selectAll().execute();
      expect(rows.map((r) => r.name)).toEqual(["captured"]);
    } finally {
      await restored.destroy();
    }
  });

  it("promoteClosest copies the nearest checkpoint over the live DB path", async () => {
    await writeFile(path.join(repoDir, "a.txt"), "v1");
    await commit(repoDir, "base");

    const seedDb = await openDatabase(liveDbPath);
    await seedDb
      .insertInto("symbols")
      .values({
        file: "file:///a.ts",
        kind: "12",
        name: "fromCheckpoint",
        def_line: 0,
        def_col: 0,
        def_end_line: 0,
        def_end_col: 5,
      })
      .execute();
    const manager = createCheckpointManager({ repoRoot: repoDir, checkpointsDir, liveDbPath });
    await manager.captureCurrent();
    await seedDb.destroy();
    await rm(liveDbPath, { force: true });
    await rm(`${liveDbPath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${liveDbPath}-shm`, { force: true }).catch(() => undefined);

    // A small change from `base` — the checkpoint just taken should still be the closest match.
    await writeFile(path.join(repoDir, "a.txt"), "v2");
    await commit(repoDir, "small change");

    const promoted = await manager.promoteClosest();
    expect(promoted).not.toBeNull();

    const promotedDb = await openDatabase(liveDbPath);
    try {
      const rows = await promotedDb.selectFrom("symbols").selectAll().execute();
      expect(rows.map((r) => r.name)).toEqual(["fromCheckpoint"]);
    } finally {
      await promotedDb.destroy();
    }
  });
});
