import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectIpc, isAddressLive } from "../src/ipc.ts";
import { startDaemon } from "../src/index.ts";
import {
  REQUEST_QUERY,
  REQUEST_SHUTDOWN,
  REQUEST_STATUS,
  type StatusResult,
} from "../src/protocol.ts";

const tscPath = process.env.TSC_LSP_PATH;
const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout.trim();
}

async function initFixtureRepo(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "--quiet"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "Test"]);
  await writeFile(
    path.join(repoDir, "greet.ts"),
    "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "--quiet", "-m", "initial"]);
}

function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      if (await check()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(() => void poll(), 50);
    };
    void poll();
  });
}

describe.skipIf(!tscPath)("daemon, end to end", () => {
  let repoDir: string;
  let dataDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-daemon-repo-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-daemon-data-"));
    await initFixtureRepo(repoDir);
  });

  afterEach(async () => {
    // On Windows, a just-exited `tsc --lsp` process or a just-closed chokidar watch can hold a
    // file handle open for a moment after the owning promise resolves; retry past it rather
    // than flake.
    await Promise.all(
      [repoDir, dataDir].map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      ),
    );
  }, 15_000);

  it("cold-indexes, answers a query over the real IPC transport, and shuts down cleanly", async () => {
    const handle = await startDaemon({
      repoRoot: repoDir,
      tscPath: tscPath!,
      baseDataDir: dataDir,
    });
    await handle.waitForColdIndex();

    const client = await connectIpc(handle.ipcAddress);
    try {
      const status = await client.sendRequest<StatusResult>(REQUEST_STATUS);
      expect(status.indexing).toBe(false);

      const report = await client.sendRequest(REQUEST_QUERY, {
        query: { type: "symbol-query", symbol: "greet" },
        report: "symbol-info",
      });
      expect(report).toMatchObject({ symbols: [{ name: "greet" }] });

      await client.sendRequest(REQUEST_SHUTDOWN);
    } finally {
      client.dispose();
    }

    await waitUntil(async () => !(await isAddressLive(handle.ipcAddress)));
  }, 30_000);

  it("a force-killed daemon leaves no state blocking a fresh daemon on the same repo", async () => {
    // Spawns the built app (`pnpm run build` must have run) so it can be force-killed as a
    // genuinely separate process — killing part of the current test process isn't possible.
    const daemonEntry = path.join(import.meta.dirname, "..", "dist", "index.js");
    const child = spawn(process.execPath, [daemonEntry, repoDir], {
      env: { ...process.env, TSC_LSP_PATH: tscPath!, CODE_QUESTION_AGENT_DATA_DIR: dataDir },
    });

    let ipcAddress: string | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /daemon listening at (.+)/.exec(chunk.toString());
      if (match?.[1]) ipcAddress = match[1].trim();
    });

    try {
      await waitUntil(() => ipcAddress !== undefined);
      await waitUntil(() => isAddressLive(ipcAddress!));

      // No SIGTERM/SIGINT — this skips every cleanup handler in `startDaemon`'s `shutdown`,
      // which is exactly the scenario the IPC design (`docs/plans/03-daemon-implementation.md`)
      // has to survive.
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      const handle = await startDaemon({
        repoRoot: repoDir,
        tscPath: tscPath!,
        baseDataDir: dataDir,
      });
      try {
        const client = await connectIpc(handle.ipcAddress);
        const status = await client.sendRequest<StatusResult>(REQUEST_STATUS);
        expect(status.pid).toBe(process.pid);
        client.dispose();
      } finally {
        await handle.shutdown();
      }
    } finally {
      if (!child.killed) child.kill();
    }
  }, 30_000);
});
