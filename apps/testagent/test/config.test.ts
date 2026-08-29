import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadConfig,
  resolveToolSelection,
  validateConfig,
  type TestAgentConfig,
} from "../src/config.ts";

const VALID = {
  enabledTools: ["cli", "grep"],
  toolLimits: { cli: 5, grep: -1 },
  maxTokenBudget: 100000,
};

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const config = validateConfig(VALID, "config.json");
    expect(config.enabledTools).toEqual(["cli", "grep"]);
    expect(config.toolLimits).toEqual({ cli: 5, grep: -1 });
    expect(config.maxTokenBudget).toBe(100000);
    expect(config.model).toBeUndefined();
    expect(config.effort).toBeUndefined();
  });

  it("accepts optional model and effort fields", () => {
    const config = validateConfig(
      { ...VALID, model: "claude-opus-5", effort: "xhigh" },
      "config.json",
    );
    expect(config.model).toBe("claude-opus-5");
    expect(config.effort).toBe("xhigh");
  });

  it("rejects an unknown tool name in enabledTools", () => {
    expect(() =>
      validateConfig({ ...VALID, enabledTools: ["cli", "nope"] }, "config.json"),
    ).toThrow(/unknown tool name/);
  });

  it("rejects an enabled tool missing from toolLimits", () => {
    expect(() =>
      validateConfig({ ...VALID, enabledTools: ["cli", "grep", "read"] }, "config.json"),
    ).toThrow(/toolLimits.*read/);
  });

  it("rejects a toolLimits value below -1", () => {
    expect(() =>
      validateConfig({ ...VALID, toolLimits: { cli: -2, grep: -1 } }, "config.json"),
    ).toThrow(/toolLimits\.cli/);
  });

  it("rejects maxTokenBudget of 0", () => {
    expect(() => validateConfig({ ...VALID, maxTokenBudget: 0 }, "config.json")).toThrow(
      /maxTokenBudget/,
    );
  });

  it("rejects an unknown effort level", () => {
    expect(() => validateConfig({ ...VALID, effort: "extreme" }, "config.json")).toThrow(/effort/);
  });
});

describe("resolveToolSelection", () => {
  const config: TestAgentConfig = {
    enabledTools: ["cli", "grep"],
    toolLimits: { cli: 5, grep: -1 },
    maxTokenBudget: -1,
  };

  it("returns config.enabledTools when --tools is omitted", () => {
    expect(resolveToolSelection(undefined, config)).toEqual(["cli", "grep"]);
  });

  it("returns the --tools subset when it's a subset of enabledTools", () => {
    expect(resolveToolSelection(["grep"], config)).toEqual(["grep"]);
  });

  it("throws when --tools names a tool outside enabledTools", () => {
    expect(() => resolveToolSelection(["read"], config)).toThrow(/enabledTools/);
  });
});

describe("loadConfig", () => {
  let workspaceDir: string;
  let invocationCwd: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-config-ws-"));
    invocationCwd = await mkdtemp(path.join(os.tmpdir(), "testagent-config-cwd-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(invocationCwd, { recursive: true, force: true });
  });

  it("prefers .testagent-config.json in the workspace dir", async () => {
    await writeFile(
      path.join(workspaceDir, ".testagent-config.json"),
      JSON.stringify({
        enabledTools: [],
        toolLimits: {},
        maxTokenBudget: -1,
        model: "from-workspace",
      }),
    );
    await writeFile(
      path.join(invocationCwd, ".testagent-config.json"),
      JSON.stringify({ enabledTools: [], toolLimits: {}, maxTokenBudget: -1, model: "from-cwd" }),
    );
    const config = await loadConfig(workspaceDir, invocationCwd);
    expect(config.model).toBe("from-workspace");
  });

  it("falls back to the invocation cwd when the workspace dir has no config", async () => {
    await writeFile(
      path.join(invocationCwd, ".testagent-config.json"),
      JSON.stringify({ enabledTools: [], toolLimits: {}, maxTokenBudget: -1, model: "from-cwd" }),
    );
    const config = await loadConfig(workspaceDir, invocationCwd);
    expect(config.model).toBe("from-cwd");
  });

  it("throws naming both candidate paths when neither has a config", async () => {
    await expect(loadConfig(workspaceDir, invocationCwd)).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes(workspaceDir) && message.includes(invocationCwd);
    });
  });
});
