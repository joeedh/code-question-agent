import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, isOpenRouterModel } from "../src/provider.ts";

describe("isOpenRouterModel", () => {
  it("treats a vendor-prefixed id as an OpenRouter model", () => {
    expect(isOpenRouterModel("z-ai/glm-5.3-flash")).toBe(true);
  });

  it("treats a bare Anthropic model id as a direct Anthropic model", () => {
    expect(isOpenRouterModel("claude-opus-5")).toBe(false);
  });
});

describe("createClient", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "testagent-provider-"));
    await mkdir(path.join(repoRoot, "keys"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("points an OpenRouter model at OpenRouter with the OpenRouter key", async () => {
    await writeFile(path.join(repoRoot, "keys", "openrouter.txt"), "sk-or-test\n");
    const client = await createClient("z-ai/glm-5.3-flash", repoRoot);
    expect(client.apiKey).toBe("sk-or-test");
    expect(client.baseURL).toBe("https://openrouter.ai/api");
  });

  it("points an Anthropic model at Anthropic with the Claude key", async () => {
    await writeFile(path.join(repoRoot, "keys", "claude.txt"), "sk-ant-test\n");
    const client = await createClient("claude-opus-5", repoRoot);
    expect(client.apiKey).toBe("sk-ant-test");
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });

  it("names the missing key file when the OpenRouter key is absent", async () => {
    await expect(createClient("z-ai/glm-5.3-flash", repoRoot)).rejects.toThrow(/openrouter\.txt/);
  });
});
