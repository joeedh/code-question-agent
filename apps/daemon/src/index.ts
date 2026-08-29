import { mkdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { type Report } from "@code-question-agent/core";
import { openDatabase, reconcile } from "@code-question-agent/db";
import { LspBridge } from "@code-question-agent/lsp-bridge";
import { createCheckpointManager } from "./checkpoints.ts";
import { createIndexer } from "./indexer.ts";
import { startIpcServer } from "./ipc.ts";
import { type DaemonMetadata, type QueryRequest } from "./protocol.ts";
import { enclosingScope, symbolLookup, whatRefs } from "./query.ts";
import { resolveRepoPaths } from "./repo.ts";
import { listTrackedFiles, watchRepo } from "./watcher.ts";

export { startIpcServer, connectIpc, isAddressLive } from "./ipc.ts";
export { resolveRepoPaths, type RepoPaths } from "./repo.ts";
export * from "./protocol.ts";

export interface DaemonOptions {
  repoRoot: string;
  /** Path to the `tsc` binary built from the TypeScript checkout (see `packages/lsp-bridge`). */
  tscPath: string;
  baseDataDir?: string;
}

export interface DaemonHandle {
  ipcAddress: string;
  shutdown: () => Promise<void>;
  /** Resolves once the initial cold-start file scan has finished indexing symbols — for tests. */
  waitForColdIndex: () => Promise<void>;
}

async function answerQuery(
  db: Awaited<ReturnType<typeof openDatabase>>,
  request: QueryRequest,
): Promise<Report> {
  switch (request.report) {
    case "symbol-info":
      return symbolLookup(db, request.query);
    case "what-refs":
      return whatRefs(db, request.query);
    case "enclosing-scope":
      return enclosingScope(db, request.query);
  }
}

/** Starts the daemon for `options.repoRoot`: promotes/cold-builds the DB, then watches and serves queries. */
export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const paths = await resolveRepoPaths(options.repoRoot, options.baseDataDir);
  await mkdir(paths.dataDir, { recursive: true });

  const checkpoints = createCheckpointManager({
    repoRoot: paths.repoRoot,
    checkpointsDir: paths.checkpointsDir,
    liveDbPath: paths.liveDbPath,
  });
  await checkpoints.promoteClosest();

  const db = await openDatabase(paths.liveDbPath);
  // A changed/removed file this reports is caught up again by the cold-start scan below (new
  // daemon, no checkpoint or a stale one) or by the watcher's own events once it starts.
  await reconcile(db);

  const bridge = new LspBridge({ tscPath: options.tscPath, rootDir: paths.repoRoot });
  await bridge.initialize();

  const indexer = createIndexer(db, bridge);
  const startedAt = new Date().toISOString();
  let indexing = true;

  const coldIndex = (async () => {
    const files = await listTrackedFiles(paths.repoRoot);
    for (const file of files) {
      await indexer.indexFile(file).catch(() => undefined);
    }
    indexing = false;
  })();

  const watcher = watchRepo(paths.repoRoot, {
    onFileChanged: (file) => void indexer.indexFile(file).catch(() => undefined),
    onFileRemoved: (file) => void indexer.removeFile(file).catch(() => undefined),
    onReflogChanged: () => void checkpoints.captureCurrent().catch(() => undefined),
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await coldIndex.catch(() => undefined);
    await watcher.close();
    await ipc.close();
    await bridge.dispose().catch(() => undefined);
    await db.destroy();
    await rm(paths.metadataPath, { force: true });
  }

  const ipc = await startIpcServer(paths.ipcAddress, {
    status: async () => ({ pid: process.pid, repoRoot: paths.repoRoot, startedAt, indexing }),
    query: (request: QueryRequest) => answerQuery(db, request),
    // `shutdown()` closes the IPC server, which waits for every open connection — including
    // this handler's own — to end first. Answering the request before running it (deferred a
    // tick, so the response reaches the caller) avoids the resulting deadlock.
    shutdown: async () => {
      setImmediate(() => void shutdown());
    },
  });

  const metadata: DaemonMetadata = { pid: process.pid, ipcAddress: paths.ipcAddress, startedAt };
  await writeFile(paths.metadataPath, JSON.stringify(metadata, null, 2));

  return { ipcAddress: paths.ipcAddress, shutdown, waitForColdIndex: () => coldIndex };
}

async function main(): Promise<void> {
  const tscPath = process.env.TSC_LSP_PATH;
  if (!tscPath) {
    console.error("TSC_LSP_PATH must point at a tsc binary built with `--lsp` support.");
    process.exitCode = 1;
    return;
  }
  const repoRoot = process.argv[2] ?? process.cwd();
  const baseDataDir = process.env.CODE_QUESTION_AGENT_DATA_DIR;
  const handle = await startDaemon({ repoRoot, tscPath, baseDataDir });
  console.log(`daemon listening at ${handle.ipcAddress}`);

  const stop = (): void => {
    void handle.shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
