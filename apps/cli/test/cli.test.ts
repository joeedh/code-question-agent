import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  connectIpc,
  REQUEST_SHUTDOWN,
  REQUEST_STATUS,
  resolveRepoPaths,
  type StatusResult,
} from "@code-question-agent/daemon";
import { type SymbolInfo, type WhatRefs } from "@code-question-agent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tscPath = process.env.TSC_LSP_PATH;
const execFileAsync = promisify(execFile);
const cliEntry = path.join(import.meta.dirname, "..", "dist", "index.js");

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
  await writeFile(
    path.join(repoDir, "caller.ts"),
    'import { greet } from "./greet.js";\n\nconsole.log(greet("world"));\n',
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "--quiet", "-m", "initial"]);
}

describe("cli --help", () => {
  it("prints usage and exits without touching the daemon", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--help"]);
    expect(stdout).toContain("Usage: code-question-agent <query> [flags]");
  });
});

describe("cli --llm-help", () => {
  it("prints LLM-oriented usage and exits without touching the daemon", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--llm-help"]);
    expect(stdout).toContain("code-question-agent");
    expect(stdout).not.toContain("Usage: code-question-agent <query> [flags]");
  });
});

describe.skipIf(!tscPath)("cli, end to end", () => {
  let repoDir: string;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cli-repo-"));
    dataDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cli-data-"));
    await initFixtureRepo(repoDir);
    env = { ...process.env, TSC_LSP_PATH: tscPath!, CODE_QUESTION_AGENT_DATA_DIR: dataDir };
  });

  afterEach(async () => {
    const paths = await resolveRepoPaths(repoDir, dataDir);
    try {
      const connection = await connectIpc(paths.ipcAddress);
      await connection.sendRequest(REQUEST_SHUTDOWN);
      connection.dispose();
    } catch {
      // No daemon left running — nothing to shut down.
    }
    await Promise.all(
      [repoDir, dataDir].map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      ),
    );
  }, 15_000);

  it("cold-spawns a daemon on the first query and reuses it on the second", async () => {
    const first = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir, "--json"],
      { env },
    );
    const firstReport = JSON.parse(first.stdout) as SymbolInfo;
    expect(firstReport.symbols).toContainEqual(expect.objectContaining({ name: "greet" }));

    const paths = await resolveRepoPaths(repoDir, dataDir);
    const statusConnection = await connectIpc(paths.ipcAddress);
    const statusAfterFirst = await statusConnection.sendRequest<StatusResult>(REQUEST_STATUS);
    statusConnection.dispose();

    await execFileAsync(process.execPath, [cliEntry, "greet", "--repo", repoDir, "--json"], {
      env,
    });

    const statusConnection2 = await connectIpc(paths.ipcAddress);
    const statusAfterSecond = await statusConnection2.sendRequest<StatusResult>(REQUEST_STATUS);
    statusConnection2.dispose();

    expect(statusAfterSecond.pid).toBe(statusAfterFirst.pid);
  }, 60_000);

  it("answers --what-refs and attaches a trace with --include-class-trace", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir, "--what-refs", "--include-class-trace", "--json"],
      { env },
    );
    const report = JSON.parse(stdout) as WhatRefs & { traces: Record<string, unknown> };
    expect(report.type).toBe("what-refs");
    expect(report.references.length).toBeGreaterThan(0);
    expect(report.traces[String(report.symbol.id)]).toBeDefined();
  }, 60_000);

  it("prints the human-readable block format by default", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir],
      { env },
    );
    expect(stdout).toContain("greet.ts");
    expect(stdout).toContain("definition");
  }, 60_000);

  it("--include/--exclude narrow a multi-file symbol match to one declaring file", async () => {
    // An exact-name lookup for `greet` matches two rows without a filter: the declaration in
    // `greet.ts` and the imported binding `caller.ts`'s own `documentSymbol` scan also reports
    // (`docs/debugging.md`'s "Hierarchical documentSymbol reports a named import as a symbol
    // too" note).
    const unfiltered = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir, "--json"],
      {
        env,
      },
    );
    const unfilteredReport = JSON.parse(unfiltered.stdout) as SymbolInfo;
    expect(unfilteredReport.symbols.length).toBeGreaterThanOrEqual(2);

    const included = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir, "--include", "greet\\.ts$", "--json"],
      { env },
    );
    const includedReport = JSON.parse(included.stdout) as SymbolInfo;
    expect(includedReport.symbols).toHaveLength(1);
    expect(includedReport.symbols[0]?.file).toMatch(/greet\.ts$/);

    const excluded = await execFileAsync(
      process.execPath,
      [cliEntry, "greet", "--repo", repoDir, "--exclude", "caller\\.ts$", "--json"],
      { env },
    );
    const excludedReport = JSON.parse(excluded.stdout) as SymbolInfo;
    expect(excludedReport.symbols).toHaveLength(1);
    expect(excludedReport.symbols[0]?.file).toMatch(/greet\.ts$/);
  }, 60_000);
});
