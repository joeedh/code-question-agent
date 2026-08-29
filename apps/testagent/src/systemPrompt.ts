import { type TestAgentConfig, type ToolName } from "./config.ts";
import { runCli } from "./tools/cli.ts";
import { TOOL_REGISTRY } from "./tools/registry.ts";

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

  if (tools.includes("cli")) {
    const { output } = await runCli(["--llm-help"], workspaceDir);
    sections.push(output.trim());
  }

  sections.push(
    `You are a test/verification agent inspecting the repository at ${workspaceDir}. ` +
      "Use the tools below to answer the task. Each tool has a limited number of calls for " +
      "this session and the session has a total token budget — be economical, and prefer " +
      "fewer, well-targeted calls over broad exploration.",
  );

  sections.push(
    ["Available tools:", ...tools.map((name) => describeTool(name, config))].join("\n"),
  );

  return sections.join("\n\n");
}
