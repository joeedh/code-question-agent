import { type TestAgentConfig, type ToolName } from "./config.ts";
import { runCli } from "./tools/cli.ts";
import { TOOL_REGISTRY } from "./tools/registry.ts";
import Path from "node:path";

function describeTool(name: ToolName, config: TestAgentConfig): string {
  const tool = TOOL_REGISTRY[name];
  const limit = config.toolLimits[name] ?? -1;
  const limitText = limit === -1 ? "unlimited calls" : `at most ${limit} call(s)`;
  return `- \`${tool.name}\`: ${tool.description} You may make ${limitText} to this tool this session.`;
}

/**
 * Builds the session's system prompt. When `cli` is enabled, its `--llm-help` output is
 * captured via the same subprocess path the `cli` tool itself uses, and prepended ahead of
 * everything else per docs/testagent.md.
 */
export async function buildSystemPrompt(
  workspaceDir: string,
  tools: ToolName[],
  config: TestAgentConfig,
): Promise<string> {
  const sections: string[] = [];

  workspaceDir = Path.resolve(workspaceDir);

  if (tools.includes("cli")) {
    const { output } = await runCli(["--llm-help"], workspaceDir);
    sections.push(output.trim());
  }

  if (tools.includes("bash")) {
    sections.push(
      `
You are a software coding agent at ${workspaceDir}.  For new projects use 
typescript 7, bundle and serve with esbuild, package with pnpm.
If making a web server serve at 0.0.0.0:1234 .

**Invoke Servers In Background!!**  Otherwise you will block the execution of subsequent commands
until the timeout is reached.  Check if your server is already running before starting it.

This harness automatically maintains a 'finalTurns.md' in the workspace with summaries of past work.

`.trim(),
    );
  } else {
    sections.push(
      `You are a test/verification agent inspecting the repository at ${workspaceDir}.`,
    );
  }

  sections.push(
    "Use the tools below to answer the task. Each tool has a limited number of calls for " +
      "this session and the session has a total token budget — be economical, and prefer " +
      "fewer, well-targeted calls over broad exploration.",
  );

  sections.push(
    ["\nAvailable tools:", ...tools.map((name) => describeTool(name, config))].join("\n"),
  );

  console.log(sections.join("\n") + "\n\n");
  return sections.join("\n");
}
