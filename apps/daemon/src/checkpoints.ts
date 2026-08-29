import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  backupDatabase,
  checkpointPath,
  DEFAULT_CHECKPOINT_BUDGET_BYTES,
  evictCheckpoints,
  findClosestCheckpoint,
  getTreeHash,
  listCheckpoints,
} from "@code-question-agent/db";

export interface CheckpointManagerOptions {
  repoRoot: string;
  checkpointsDir: string;
  liveDbPath: string;
  budgetBytes?: number;
}

export interface CheckpointManager {
  /** Copies the closest checkpoint (if any) over `liveDbPath`, before it's opened. */
  promoteClosest: () => Promise<{ treeHash: string; changedFiles: number } | null>;
  /** Backs up the (open, live) DB as a checkpoint for HEAD's current tree hash, then evicts over budget. */
  captureCurrent: () => Promise<void>;
}

export function createCheckpointManager(options: CheckpointManagerOptions): CheckpointManager {
  const budgetBytes = options.budgetBytes ?? DEFAULT_CHECKPOINT_BUDGET_BYTES;

  async function promoteClosest(): ReturnType<CheckpointManager["promoteClosest"]> {
    const targetTree = await getTreeHash(options.repoRoot);
    const candidates = await listCheckpoints(options.checkpointsDir);
    if (candidates.length === 0) return null;

    const best = await findClosestCheckpoint(options.repoRoot, targetTree, candidates);
    if (!best) return null;

    await mkdir(path.dirname(options.liveDbPath), { recursive: true });
    // At this point nothing has `liveDbPath` or the checkpoint file open yet — a plain file
    // copy is safe here, unlike `captureCurrent`, which copies out of an already-open DB.
    await copyFile(checkpointPath(options.checkpointsDir, best.treeHash), options.liveDbPath);
    return best;
  }

  async function captureCurrent(): Promise<void> {
    const treeHash = await getTreeHash(options.repoRoot);
    await mkdir(options.checkpointsDir, { recursive: true });
    await backupDatabase(options.liveDbPath, checkpointPath(options.checkpointsDir, treeHash));
    await evictCheckpoints(options.checkpointsDir, budgetBytes, new Set([treeHash]));
  }

  return { promoteClosest, captureCurrent };
}
