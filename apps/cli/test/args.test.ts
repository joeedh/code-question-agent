import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.ts";

describe("parseCliArgs", () => {
  it("applies defaults for a bare symbol query", () => {
    const opts = parseCliArgs(["greet"]);
    expect(opts).toMatchObject({
      query: "greet",
      regexp: false,
      whatRefs: false,
      includeClassTrace: false,
      contextLines: 0,
      includeLine: true,
      excludeColumn: false,
      json: false,
      noWait: false,
    });
    expect(opts.file).toBeUndefined();
    expect(opts.line).toBeUndefined();
    expect(opts.col).toBeUndefined();
    expect(opts.fileInclude).toBeUndefined();
    expect(opts.fileExclude).toBeUndefined();
  });

  it("parses every flag", () => {
    const opts = parseCliArgs([
      "^Greet.*",
      "--regexp",
      "--what-refs",
      "--include-class-trace",
      "--file",
      "src/greeter.ts",
      "--line",
      "3",
      "--col",
      "7",
      "--include",
      "[\\\\/]src[\\\\/]",
      "--exclude",
      "[\\\\/]test[\\\\/]",
      "--context-lines",
      "2",
      "--exclude-column",
      "--json",
      "--repo",
      "/tmp/repo",
      "--no-wait",
      "--timeout",
      "5000",
    ]);
    expect(opts).toEqual({
      query: "^Greet.*",
      regexp: true,
      whatRefs: true,
      includeClassTrace: true,
      file: "src/greeter.ts",
      line: 3,
      col: 7,
      fileInclude: "[\\\\/]src[\\\\/]",
      fileExclude: "[\\\\/]test[\\\\/]",
      contextLines: 2,
      includeLine: true,
      excludeColumn: true,
      json: true,
      repo: "/tmp/repo",
      noWait: true,
      timeoutMs: 5000,
    });
  });

  it("throws when the query positional is missing", () => {
    expect(() => parseCliArgs(["--json"])).toThrow(/query/i);
  });

  it("throws a clear error on a non-numeric --line", () => {
    expect(() => parseCliArgs(["greet", "--line", "nope"])).toThrow(/--line/);
  });

  it("throws a clear error on a malformed --include regexp", () => {
    expect(() => parseCliArgs(["greet", "--include", "(unclosed"])).toThrow(/--include/);
  });

  it("throws a clear error on a malformed --exclude regexp", () => {
    expect(() => parseCliArgs(["greet", "--exclude", "["])).toThrow(/--exclude/);
  });
});
