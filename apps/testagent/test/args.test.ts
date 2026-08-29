import { describe, expect, it } from "vitest";
import { formatHelp, parseTestAgentArgs } from "../src/args.ts";

describe("parseTestAgentArgs", () => {
  it("applies defaults for a bare workspace path", () => {
    const opts = parseTestAgentArgs(["/tmp/repo", "--goal", "do the thing"]);
    expect(opts).toEqual({
      help: false,
      workspaceDir: "/tmp/repo",
      tools: undefined,
      goal: "do the thing",
    });
  });

  it("parses --tools into a validated list", () => {
    const opts = parseTestAgentArgs(["/tmp/repo", "--tools", "grep,cli", "--goal", "x"]);
    expect(opts.tools).toEqual(["grep", "cli"]);
  });

  it("throws on an unknown tool name", () => {
    expect(() => parseTestAgentArgs(["/tmp/repo", "--tools", "nope"])).toThrow(/unknown tool/);
  });

  it("throws when the workspace dir positional is missing", () => {
    expect(() => parseTestAgentArgs(["--goal", "x"])).toThrow(/workspace directory/);
  });

  it("does not require a workspace dir when --help is given", () => {
    const opts = parseTestAgentArgs(["--help"]);
    expect(opts.help).toBe(true);
  });

  it("accepts -h as a short alias for --help", () => {
    const opts = parseTestAgentArgs(["-h"]);
    expect(opts.help).toBe(true);
  });
});

describe("formatHelp", () => {
  it("documents the invocation and every flag", () => {
    const help = formatHelp();
    expect(help).toContain("pnpm testagent");
    for (const flag of ["--tools", "--goal", "--help"]) {
      expect(help).toContain(flag);
    }
  });
});
