import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliTool } from "../../src/tools/cli.ts";

const cliEntry = path.resolve(import.meta.dirname, "../../../cli/dist/index.js");

describe.runIf(existsSync(cliEntry))("cliTool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-cli-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("spawns the code-question-agent CLI and captures its output", async () => {
    const result = await cliTool.run({ args: ["--llm-help"] }, { workspaceDir });
    expect(result).toContain("exit code: 0");
    expect(result).toContain("code-question-agent");
  });
});
