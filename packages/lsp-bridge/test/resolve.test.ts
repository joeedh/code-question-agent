import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findInstalledTsc, resolveTscPath } from "../src/resolve.ts";

vi.mock("node:url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:url")>();
  return { ...actual, fileURLToPath: vi.fn(actual.fileURLToPath) };
});

async function writeTypescriptPackage(
  nodeModulesDir: string,
  version: string,
  bin: Record<string, string> | string = { tsc: "./bin/tsc" },
): Promise<void> {
  const pkgDir = path.join(nodeModulesDir, "typescript");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ version, bin }));
  const binField = typeof bin === "string" ? bin : bin.tsc;
  if (binField) {
    const binPath = path.join(pkgDir, binField);
    await mkdir(path.dirname(binPath), { recursive: true });
    await writeFile(binPath, "#!/usr/bin/env node\n");
  }
}

describe("findInstalledTsc / resolveTscPath", () => {
  let repoDir: string;
  let originalTscLspPath: string | undefined;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-resolve-"));
    originalTscLspPath = process.env.TSC_LSP_PATH;
    delete process.env.TSC_LSP_PATH;
  });

  afterEach(async () => {
    if (originalTscLspPath === undefined) delete process.env.TSC_LSP_PATH;
    else process.env.TSC_LSP_PATH = originalTscLspPath;
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns undefined when nothing is installed", () => {
    expect(findInstalledTsc(repoDir)).toBeUndefined();
  });

  it("resolves a TypeScript 7 install's bin/tsc", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "7.0.2");
    expect(findInstalledTsc(repoDir)).toBe(
      path.join(repoDir, "node_modules", "typescript", "bin", "tsc"),
    );
  });

  it("rejects a pre-7 TypeScript install (no --lsp support)", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "5.6.0");
    expect(findInstalledTsc(repoDir)).toBeUndefined();
  });

  it("accepts a string-shaped bin field", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "7.0.2", "./bin/tsc");
    expect(findInstalledTsc(repoDir)).toBe(
      path.join(repoDir, "node_modules", "typescript", "bin", "tsc"),
    );
  });

  it("walks up from a nested subdirectory to a workspace-root install", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "7.0.2");
    const nested = path.join(repoDir, "packages", "app");
    await mkdir(nested, { recursive: true });
    expect(findInstalledTsc(nested)).toBe(
      path.join(repoDir, "node_modules", "typescript", "bin", "tsc"),
    );
  });

  it("resolveTscPath prefers TSC_LSP_PATH over an installed typescript", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "7.0.2");
    process.env.TSC_LSP_PATH = "C:\\custom\\tsc.exe";
    expect(resolveTscPath(repoDir)).toBe("C:\\custom\\tsc.exe");
  });

  it("resolveTscPath falls back to an installed typescript without TSC_LSP_PATH", async () => {
    await writeTypescriptPackage(path.join(repoDir, "node_modules"), "7.0.2");
    expect(resolveTscPath(repoDir)).toBe(
      path.join(repoDir, "node_modules", "typescript", "bin", "tsc"),
    );
  });

  it("resolveTscPath falls back to this checkout's own typescript for an unrelated repo", () => {
    // These tests run from inside the actual code-question-agent checkout, which has its own
    // `typescript` (7+) installed — exactly the scenario this fallback exists for: `repoDir`
    // has none of its own, but this tool's own dev install can still answer for it.
    const resolved = resolveTscPath(repoDir);
    expect(resolved).toMatch(/typescript[\\/]bin[\\/]tsc$/);
    expect(resolved).not.toContain(repoDir);
  });

  it("resolveTscPath throws when TSC_LSP_PATH, a target install, and a self checkout are all unavailable", () => {
    vi.mocked(fileURLToPath).mockImplementationOnce(() => path.join(repoDir, "fake-resolve.ts"));
    expect(() => resolveTscPath(repoDir)).toThrow(/TSC_LSP_PATH|typescript/);
  });
});
