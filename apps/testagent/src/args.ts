import { parseArgs } from "node:util";
import { TOOL_NAMES, type ToolName } from "./config.ts";

export interface TestAgentOptions {
  help: boolean;
  workspaceDir: string;
  tools?: ToolName[];
  goal: string;
}

function parseToolsFlag(value: string | undefined): ToolName[] | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of names) {
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `--tools: unknown tool ${JSON.stringify(name)} (known: ${TOOL_NAMES.join(", ")})`,
      );
    }
  }
  return names as ToolName[];
}

/** Parses `argv` (excluding `node`/script) into `TestAgentOptions`. */
export function parseTestAgentArgs(argv: string[]): TestAgentOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      tools: { type: "string" },
      goal: { type: "string" },
    },
  });

  const workspaceDir = positionals[0];
  if (!values.help && workspaceDir === undefined) {
    throw new Error("a path to the workspace directory is required");
  }

  return {
    help: values.help,
    workspaceDir: workspaceDir ?? "",
    tools: parseToolsFlag(values.tools),
    goal: values.goal ?? "",
  };
}

const HELP_TEXT = `Usage: pnpm testagent -- <path-to-workspace-dir> [flags]

  <path-to-workspace-dir>  Repo the agent inspects. Its .testagent-config.json
                            configures which tools are enabled, their call
                            limits, the token budget, and the model.

Flags:
  --tools <a,b,c>   Restrict this run to a subset of the config's enabledTools
                    (cli, grep, read, ls). Omit to use every enabled tool.
  --goal <text>     The task to give the agent. Required unless --help.
  -h, --help        Print this help and exit.

See docs/testagent.md for the full reference.`;

/** Usage text for `--help`/`-h`. */
export function formatHelp(): string {
  return HELP_TEXT;
}
