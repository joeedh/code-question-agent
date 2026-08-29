import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectFileFilter } from "../src/tsconfig.ts";

describe("loadProjectFileFilter", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-tsconfig-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  function abs(...segments: string[]): string {
    return path.join(repoDir, ...segments);
  }

  it("accepts everything when there is no tsconfig.json", () => {
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("build", "bundle.js"))).toBe(true);
    expect(filter.isProjectFile(abs("src", "index.ts"))).toBe(true);
  });

  it("accepts everything when tsconfig.json can't be parsed", async () => {
    await writeFile(abs("tsconfig.json"), "{ not json");
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("build", "bundle.js"))).toBe(true);
  });

  it("narrows to include and excludes a bare-name directory (nstructjs's own shape)", async () => {
    await writeFile(
      abs("tsconfig.json"),
      JSON.stringify({
        compilerOptions: { rootDir: "./src", outDir: "./build" },
        include: ["src/**/*.ts"],
        exclude: ["node_modules", "dist", "build", "tests"],
      }),
    );
    const filter = loadProjectFileFilter(repoDir);

    expect(filter.isProjectFile(abs("src", "structjs.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("src", "nested", "deep.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("build", "nstructjs_es6.js"))).toBe(false);
    expect(filter.isProjectFile(abs("tests", "struct.test.ts"))).toBe(false);
    expect(filter.isProjectFile(abs("docs", "assets", "main.js"))).toBe(false);
    expect(filter.isProjectFile(abs("README.md"))).toBe(false);
  });

  it("tolerates comments and trailing commas (a real tsconfig.json is JSONC)", async () => {
    await writeFile(
      abs("tsconfig.json"),
      [
        "{",
        '  // narrow to source only',
        '  "include": ["src/**/*.ts"],',
        '  "exclude": ["build"],',
        "}",
      ].join("\n"),
    );
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("src", "index.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("build", "bundle.js"))).toBe(false);
  });

  it("keeps files listed in `files` even without a matching `include` glob", async () => {
    await writeFile(
      abs("tsconfig.json"),
      JSON.stringify({ include: ["src/**/*.ts"], files: ["shims.d.ts"] }),
    );
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("shims.d.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("random.ts"))).toBe(false);
  });

  it("treats a bare directory in include as everything beneath it", async () => {
    await writeFile(abs("tsconfig.json"), JSON.stringify({ include: ["src"] }));
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("src", "index.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("src", "nested", "deep.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("build", "bundle.js"))).toBe(false);
  });

  it("applies only exclude when there is no include", async () => {
    await writeFile(abs("tsconfig.json"), JSON.stringify({ exclude: ["build"] }));
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("src", "index.ts"))).toBe(true);
    expect(filter.isProjectFile(abs("README.md"))).toBe(true);
    expect(filter.isProjectFile(abs("build", "bundle.js"))).toBe(false);
  });

  it("always excludes node_modules even if exclude doesn't list it", async () => {
    await writeFile(abs("tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
    const filter = loadProjectFileFilter(repoDir);
    expect(filter.isProjectFile(abs("node_modules", "dep", "index.ts"))).toBe(false);
  });
});
