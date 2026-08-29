import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTranscript } from "../src/transcript.ts";

describe("openTranscript", () => {
  let invocationCwd: string;
  let workspaceDir: string;

  beforeEach(async () => {
    invocationCwd = await mkdtemp(path.join(os.tmpdir(), "testagent-transcript-cwd-"));
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-transcript-ws-"));
  });

  afterEach(async () => {
    await rm(invocationCwd, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("writes the session file under <invocationCwd>/.testagent, not the workspace dir", async () => {
    await openTranscript(invocationCwd, {
      workspaceDir,
      tools: [],
      model: "claude-opus-5",
      effort: "high",
      maxTokenBudget: -1,
      toolLimits: {},
    });

    const cwdEntries = await readdir(path.join(invocationCwd, ".testagent"));
    expect(cwdEntries).toHaveLength(1);
    expect(cwdEntries[0]).toMatch(/^session-.*\.jsonl$/);

    await expect(readdir(path.join(workspaceDir, ".testagent"))).rejects.toThrow();
  });
});
