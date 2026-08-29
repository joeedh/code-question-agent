import { execFile } from "node:child_process";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default total size budget for a repo's `checkpoints/` directory, per `docs/plans/03-daemon-implementation.md`. */
export const DEFAULT_CHECKPOINT_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout.trim();
}

/**
 * The cache-identity base per `docs/initialDesign.md`: a commit's tree hash, which already
 * recursively encodes every submodule's pinned commit via its gitlink. Uncommitted working-tree
 * changes are handled as a separate overlay by the live-DB file watcher, not folded into this.
 */
export async function getTreeHash(repoDir: string, ref = "HEAD"): Promise<string> {
  return git(repoDir, ["rev-parse", `${ref}^{tree}`]);
}

/** Tree hashes of the checkpoint files present in `checkpointsDir` — the directory listing is the catalog. */
export async function listCheckpoints(checkpointsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(checkpointsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.basename(name, ".sqlite"));
}

export function checkpointPath(checkpointsDir: string, treeHash: string): string {
  return path.join(checkpointsDir, `${treeHash}.sqlite`);
}

/**
 * Picks the checkpoint with the smallest `git diff --name-status` against `targetTreeHash` —
 * a candidate two hops away with a small diff beats a one-hop candidate across a big refactor,
 * per `docs/initialDesign.md`'s cold-start algorithm.
 */
export async function findClosestCheckpoint(
  repoDir: string,
  targetTreeHash: string,
  candidateTreeHashes: string[],
): Promise<{ treeHash: string; changedFiles: number } | null> {
  let best: { treeHash: string; changedFiles: number } | null = null;
  for (const candidate of candidateTreeHashes) {
    const diff = await git(repoDir, [
      "diff",
      "--name-status",
      "--find-renames",
      candidate,
      targetTreeHash,
    ]);
    const changedFiles = diff.length === 0 ? 0 : diff.split("\n").length;
    if (best === null || changedFiles < best.changedFiles) {
      best = { treeHash: candidate, changedFiles };
    }
  }
  return best;
}

/**
 * Deletes checkpoints oldest-mtime-first once `checkpointsDir`'s total size exceeds
 * `budgetBytes`, per `docs/initialDesign.md`'s retention policy — never a tree hash in
 * `protectedTreeHashes` (the current HEAD of every worktree the daemon knows about).
 */
export async function evictCheckpoints(
  checkpointsDir: string,
  budgetBytes: number,
  protectedTreeHashes: ReadonlySet<string>,
): Promise<string[]> {
  const treeHashes = await listCheckpoints(checkpointsDir);
  const entries = await Promise.all(
    treeHashes.map(async (treeHash) => {
      const filePath = checkpointPath(checkpointsDir, treeHash);
      const info = await stat(filePath);
      return { treeHash, filePath, size: info.size, mtimeMs: info.mtimeMs };
    }),
  );

  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const evictable = entries
    .filter((entry) => !protectedTreeHashes.has(entry.treeHash))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  const evicted: string[] = [];
  for (const entry of evictable) {
    if (total <= budgetBytes) break;
    await unlink(entry.filePath);
    total -= entry.size;
    evicted.push(entry.treeHash);
  }
  return evicted;
}

export interface SubmoduleDrift {
  path: string;
  checkedOutCommit: string;
}

/**
 * Submodules whose on-disk `HEAD` disagrees with the parent repo's recorded gitlink —
 * `git submodule status` marks these with a leading `+`, which is exactly this comparison
 * without hand-walking `.gitmodules`.
 */
export async function getSubmoduleDrift(repoDir: string): Promise<SubmoduleDrift[]> {
  let output: string;
  try {
    output = await git(repoDir, ["submodule", "status"]);
  } catch {
    return [];
  }
  if (output.length === 0) return [];

  const drifted: SubmoduleDrift[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("+")) continue;
    const [commit, submodulePath] = line.slice(1).trim().split(/\s+/);
    if (commit && submodulePath) {
      drifted.push({ path: submodulePath, checkedOutCommit: commit });
    }
  }
  return drifted;
}
