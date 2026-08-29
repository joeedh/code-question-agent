import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface RepoPaths {
  repoId: string;
  repoRoot: string;
  dataDir: string;
  liveDbPath: string;
  checkpointsDir: string;
  metadataPath: string;
  ipcAddress: string;
}

const DEFAULT_BASE_DATA_DIR = path.join(homedir(), ".code-question-agent");

/**
 * Derives everything the daemon needs to find its state for a working directory: a stable id
 * from the resolved real path (so a symlinked or relative path to the same repo lands on the
 * same daemon), the data-dir layout `docs/plans/03-daemon-implementation.md` settled on, and
 * the platform-specific IPC address — a Windows named pipe or a POSIX Unix domain socket path,
 * never a TCP port.
 */
export async function resolveRepoPaths(
  repoRoot: string,
  baseDataDir: string = DEFAULT_BASE_DATA_DIR,
): Promise<RepoPaths> {
  const resolvedRoot = await realpath(repoRoot);
  const repoId = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 16);
  const dataDir = path.join(baseDataDir, "repos", repoId);

  return {
    repoId,
    repoRoot: resolvedRoot,
    dataDir,
    liveDbPath: path.join(dataDir, "live.sqlite"),
    checkpointsDir: path.join(dataDir, "checkpoints"),
    metadataPath: path.join(dataDir, "daemon.json"),
    ipcAddress: ipcAddressFor(repoId),
  };
}

/**
 * Unix domain socket paths have a platform-specific length limit (historically ~104-108
 * bytes) that a home-dir-nested path can bump into, so the socket — unlike the rest of the
 * daemon's state — lives under `XDG_RUNTIME_DIR` (or the OS temp dir as a fallback) rather
 * than under `dataDir`. `vscode-jsonrpc`'s own `generateRandomPipeName` uses the same
 * fallback for the same reason.
 */
function ipcAddressFor(repoId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\code-question-agent-${repoId}`;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  return path.join(runtimeDir, `code-question-agent-${repoId}.sock`);
}
