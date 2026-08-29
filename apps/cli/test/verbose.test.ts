import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliOptions } from "../src/args.ts";
import { createVerboseLogger } from "../src/verbose.ts";

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

describe("createVerboseLogger", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("is a no-op for every tag when verbose is off", () => {
    const logger = createVerboseLogger(baseOpts({ verbose: false }));
    expect(logger.isEnabled("scan")).toBe(false);
    logger.log("scan", "should not print");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("enables every tag on a bare -v", () => {
    const logger = createVerboseLogger(baseOpts({ verbose: true, verboseTags: undefined }));
    expect(logger.isEnabled("scan")).toBe(true);
    expect(logger.isEnabled("daemon")).toBe(true);
    logger.log("scan", "indexing…");
    expect(errorSpy).toHaveBeenCalledWith("[scan] indexing…");
  });

  it("restricts output to the listed tags", () => {
    const logger = createVerboseLogger(baseOpts({ verbose: true, verboseTags: ["daemon"] }));
    expect(logger.isEnabled("scan")).toBe(false);
    expect(logger.isEnabled("daemon")).toBe(true);
    logger.log("scan", "should not print");
    logger.log("daemon", "spawning daemon");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("[daemon] spawning daemon");
  });
});
