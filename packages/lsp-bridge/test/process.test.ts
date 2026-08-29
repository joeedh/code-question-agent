import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSpawnCommand } from "../src/process.ts";

describe("resolveSpawnCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-lsp-process-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a node-shebang script (an npm-installed typescript's bin/tsc) through node", async () => {
    const scriptPath = path.join(dir, "tsc");
    await writeFile(scriptPath, '#!/usr/bin/env node\nimport "../lib/tsc.js";\n');
    chmodSync(scriptPath, 0o755);

    expect(resolveSpawnCommand(scriptPath)).toEqual({
      command: process.execPath,
      args: [scriptPath, "--lsp", "--stdio"],
    });
  });

  it("runs a directly-executable binary as-is", async () => {
    const binaryPath = path.join(dir, "tsc.exe");
    // A stand-in for a native binary: no shebang, arbitrary non-text bytes up front.
    await writeFile(binaryPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

    expect(resolveSpawnCommand(binaryPath)).toEqual({
      command: binaryPath,
      args: ["--lsp", "--stdio"],
    });
  });

  it("treats a shebang for something other than node as directly executable", async () => {
    const scriptPath = path.join(dir, "tsc.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho not-node\n");

    expect(resolveSpawnCommand(scriptPath)).toEqual({
      command: scriptPath,
      args: ["--lsp", "--stdio"],
    });
  });

  it("falls back to direct execution when the path doesn't exist", () => {
    const missingPath = path.join(dir, "does-not-exist");
    expect(resolveSpawnCommand(missingPath)).toEqual({
      command: missingPath,
      args: ["--lsp", "--stdio"],
    });
  });
});
