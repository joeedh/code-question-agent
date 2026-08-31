import fs from "node:fs";
import path from "node:path";
import { IGNORED_DIR_NAMES, resolveWorkspacePath, truncateResult, type Tool } from "./types.ts";
import type { TestAgentConfig } from "../config.ts";
import { skipPath, filterCode } from "../config.ts";
import { fileCache } from "../utils.ts";
import child_process from "node:child_process";
import Path from "path";

export const bashTool: Tool = {
  name: "bash",
  description: `Executes a bash script you provide, cwd always starts out at the workspace root.`,
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", description: "Bash script" },
      truncateBytes: {
        type: "integer",
        description:
          "Maximum number of bytes to include in the result. 0 or missing defaults to no truncation.",
      },
    },
    required: ["script"],
  },
  async run(input, ctx) {
    const { script, truncateBytes } = input as {
      script: string;
      truncateBytes?: number;
    };

    let maxChars = truncateBytes === undefined || truncateBytes <= 0 ? undefined : truncateBytes;

    const root = ctx.workspaceDir;
    const tempPath = Path.join(process.cwd(), "temp", (Math.random() * 10000).toFixed(1) + ".sh");

    // ensure directories exist
    fs.mkdirSync(Path.join(process.cwd(), "temp"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(tempPath, script);
    let result = ''
    try {
      result = child_process.execSync(`bash ${tempPath}`, { encoding: "utf-8", cwd: root, timeout: 20000 });
    } catch (error: any) {
      if (error.code === 'ETIMEDOUT') {
        result = `[Command timed out after 20 seconds]`
      } else {
        result = `[Command failed: ${error.message}]`
      }
    }
    return truncateResult(result, maxChars);
  },
};
