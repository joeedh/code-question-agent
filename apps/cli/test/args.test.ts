import { describe, expect, it } from "vitest";
import { formatHelp, parseCliArgs } from "../src/args.ts";

describe("parseCliArgs", () => {
  it("applies defaults for a bare symbol query", () => {
    const opts = parseCliArgs(["greet"]);
    expect(opts).toMatchObject({
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
      help: false,
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
      verbose: false,
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

  it("does not require a query when --help is given", () => {
    const opts = parseCliArgs(["--help"]);
    expect(opts.help).toBe(true);
  });

  it("accepts -h as a short alias for --help", () => {
    const opts = parseCliArgs(["-h"]);
    expect(opts.help).toBe(true);
  });

  it("accepts --query-file in place of the positional query", () => {
    const opts = parseCliArgs(["--query-file", "query.txt"]);
    expect(opts.queryFile).toBe("query.txt");
    expect(opts.query).toBe("");
  });

  it("throws when both a positional query and --query-file are given", () => {
    expect(() => parseCliArgs(["greet", "--query-file", "query.txt"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("does not require a query when --query-file is given", () => {
    expect(() => parseCliArgs(["--query-file", "query.txt"])).not.toThrow();
  });

  it("defaults verbose to off with no tags", () => {
    const opts = parseCliArgs(["greet"]);
    expect(opts.verbose).toBe(false);
    expect(opts.verboseTags).toBeUndefined();
  });

  it("enables every tag on a bare -v", () => {
    const opts = parseCliArgs(["greet", "-v"]);
    expect(opts.verbose).toBe(true);
    expect(opts.verboseTags).toBeUndefined();
  });

  it("enables every tag on a bare --verbose", () => {
    const opts = parseCliArgs(["greet", "--verbose"]);
    expect(opts.verbose).toBe(true);
    expect(opts.verboseTags).toBeUndefined();
  });

  it("parses -v=tag1,tag2 as a scoped tag list", () => {
    const opts = parseCliArgs(["greet", "-v=scan,daemon"]);
    expect(opts.verbose).toBe(true);
    expect(opts.verboseTags).toEqual(["scan", "daemon"]);
  });

  it("parses -vtag1,tag2 (no =) the same way", () => {
    const opts = parseCliArgs(["greet", "-vscan,daemon"]);
    expect(opts.verbose).toBe(true);
    expect(opts.verboseTags).toEqual(["scan", "daemon"]);
  });

  it("parses --verbose=tag1,tag2 the same way", () => {
    const opts = parseCliArgs(["greet", "--verbose=scan,daemon"]);
    expect(opts.verbose).toBe(true);
    expect(opts.verboseTags).toEqual(["scan", "daemon"]);
  });

  it("does not confuse -v with other flags or the query positional", () => {
    const opts = parseCliArgs(["greet", "-v=scan", "--json"]);
    expect(opts.query).toBe("greet");
    expect(opts.json).toBe(true);
    expect(opts.verboseTags).toEqual(["scan"]);
  });
});

describe("formatHelp", () => {
  it("documents the invocation and every flag", () => {
    const help = formatHelp();
    expect(help).toContain("Usage: code-question-agent <query> [flags]");
    for (const flag of [
      "--regexp",
      "--file",
      "--line",
      "--col",
      "--include",
      "--exclude",
      "--what-refs",
      "--include-class-trace",
      "--json",
      "--context-lines",
      "--include-line",
      "--exclude-column",
      "--repo",
      "--no-wait",
      "--timeout",
      "--query-file",
      "--verbose",
      "--help",
    ]) {
      expect(help).toContain(flag);
    }
  });
});
