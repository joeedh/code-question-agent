import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliOptions } from "../src/args.ts";
import { resolveQueryInput } from "../src/queryInput.ts";

function baseOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    help: false,
    query: "greet",
    regexp: false,
    whatRefs: false,
    includeClassTrace: false,
    contextLines: 0,
    includeLine: true,
    excludeColumn: false,
    json: false,
    noWait: false,
    timeoutMs: 1000,
    verbose: false,
    ...overrides,
  };
}

describe("resolveQueryInput", () => {
  it("returns opts.query when no --query-file was given", async () => {
    expect(await resolveQueryInput(baseOpts({ query: "greet" }))).toBe("greet");
  });

  describe("with --query-file", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-cli-queryfile-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads and trims the file's contents", async () => {
      const file = path.join(dir, "query.txt");
      await writeFile(file, "  ^Greet.*\n");
      expect(await resolveQueryInput(baseOpts({ query: "", queryFile: file }))).toBe("^Greet.*");
    });

    it("rejects when the file does not exist", async () => {
      const file = path.join(dir, "missing.txt");
      await expect(resolveQueryInput(baseOpts({ query: "", queryFile: file }))).rejects.toThrow();
    });
  });
});
