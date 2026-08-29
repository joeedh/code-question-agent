import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { truncateResult, type Tool } from "./types.ts";

const TIMEOUT_MS = 60_000;

function resolveCliEntry(): string {
  return fileURLToPath(import.meta.resolve("@code-question-agent/cli"));
}

/** Runs the `code-question-agent` CLI bin with `args` as a subprocess, capturing combined output. */
export async function runCli(
  args: string[],
  cwd: string,
): Promise<{ output: string; exitCode: number | null }> {
  const entry = resolveCliEntry();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cli tool timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ output, exitCode });
    });
  });
}

export const cliTool: Tool = {
  name: "cli",
  description:
    "Invokes the code-question-agent CLI (symbol/reference lookups in this TypeScript repo). " +
    "Consult the CLI's own help text (prepended to this system prompt) for its flags.",
  inputSchema: {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: 'Argv to pass to the CLI, e.g. ["greet", "--json"].',
      },
    },
    required: ["args"],
  },
  async run(input, ctx) {
    const { args } = input as { args: string[] };
    const { output, exitCode } = await runCli(args, ctx.workspaceDir);
    const result = truncateResult(`exit code: ${exitCode}\n${output}`);
    console.log(result)
    return result;
  },
};
