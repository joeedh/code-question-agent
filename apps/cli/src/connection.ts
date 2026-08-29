import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  connectIpc,
  isAddressLive,
  REQUEST_STATUS,
  resolveRepoPaths,
  type RepoPaths,
  type StatusResult,
} from "@code-question-agent/daemon";
import { type MessageConnection } from "vscode-jsonrpc/node";
import { type CliOptions } from "./args.ts";
import { createVerboseLogger } from "./verbose.ts";

const POLL_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilLive(address: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await isAddressLive(address))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for the daemon to start listening at ${address}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Spawns the daemon detached and unreferenced so it outlives this CLI invocation.
 * `resolveRepoPaths` computes the same deterministic IPC address the daemon will bind to, so
 * the caller doesn't need to read the spawned process's stdout to find it.
 */
function spawnDaemon(repoRoot: string): void {
  const tscPath = process.env.TSC_LSP_PATH;
  if (!tscPath) {
    throw new Error(
      "TSC_LSP_PATH must point at a tsc binary built with `--lsp` support to start the daemon.",
    );
  }
  const daemonEntry = fileURLToPath(import.meta.resolve("@code-question-agent/daemon"));
  const child = spawn(process.execPath, [daemonEntry, repoRoot], {
    detached: true,
    // On Windows, a detached child otherwise gets its own console window — Node's documented
    // behavior, not a bug in the child process itself.
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, TSC_LSP_PATH: tscPath },
  });
  child.unref();
}

export interface DaemonConnection {
  connection: MessageConnection;
  paths: RepoPaths;
}

/** Connects to the daemon for `repoRoot`, spawning it first if nothing is listening yet. */
export async function ensureDaemon(repoRoot: string, opts: CliOptions): Promise<DaemonConnection> {
  const logger = createVerboseLogger(opts);
  const paths = await resolveRepoPaths(repoRoot, process.env.CODE_QUESTION_AGENT_DATA_DIR);

  if (await isAddressLive(paths.ipcAddress)) {
    logger.log("daemon", `connected to existing daemon at ${paths.ipcAddress}`);
  } else {
    logger.log("daemon", `spawning daemon for ${paths.repoRoot}`);
    spawnDaemon(paths.repoRoot);
    await waitUntilLive(paths.ipcAddress, opts.timeoutMs);
    logger.log("daemon", `daemon listening at ${paths.ipcAddress}`);
  }

  const connection = await connectIpc(paths.ipcAddress);
  return { connection, paths };
}

function formatScanProgress(status: StatusResult): string | undefined {
  if (status.filesTotal === undefined) return undefined;
  return `indexing… ${status.filesIndexed ?? 0}/${status.filesTotal} files`;
}

/**
 * Polls `status` until the cold-start index finishes. Without `-v`'s `scan` tag, prints a
 * one-time "indexing…" notice; with it, prints the file-count progress as it changes.
 */
export async function waitForIndexing(
  connection: MessageConnection,
  opts: CliOptions,
): Promise<void> {
  if (opts.noWait) return;

  let status = await connection.sendRequest<StatusResult>(REQUEST_STATUS);
  if (!status.indexing) return;

  const logger = createVerboseLogger(opts);
  const showScanProgress = logger.isEnabled("scan");
  if (!showScanProgress) console.error("indexing…");

  let lastReported: number | undefined;
  const deadline = Date.now() + opts.timeoutMs;
  while (status.indexing) {
    if (showScanProgress && status.filesIndexed !== lastReported) {
      const progress = formatScanProgress(status);
      if (progress) logger.log("scan", progress);
      lastReported = status.filesIndexed;
    }
    if (Date.now() > deadline) {
      console.error("still indexing after the timeout — answering from the index as it stands.");
      return;
    }
    await sleep(POLL_INTERVAL_MS);
    status = await connection.sendRequest<StatusResult>(REQUEST_STATUS);
  }
  if (showScanProgress) {
    const progress = formatScanProgress(status);
    if (progress) logger.log("scan", progress);
  }
}
