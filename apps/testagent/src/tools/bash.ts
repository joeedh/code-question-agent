import fs from "node:fs";
import path from "node:path";
import { IGNORED_DIR_NAMES, resolveWorkspacePath, truncateResult, type Tool } from "./types.ts";
import type { TestAgentConfig } from "../config.ts";
import { skipPath, filterCode } from "../config.ts";
import { fileCache } from "../utils.ts";
import child_process from "node:child_process";
import Path from "path";

function runScriptAsync(tempPath: string, root: string, timeout=40000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn('bash', [tempPath], {
      cwd: root,
      timeout,
    });

    let buf = '';
    
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');

    // Stream stdout as data arrives
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      buf += data;
    });

    // Stream stderr as data arrives
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      buf += data;
    });

    // Handle spawn/system-level errors (e.g. timeout or command not found)
    child.on('error', (err) => {
      reject(err);
    });

    // Handle process completion
    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') {
        return reject(new Error('Process timed out after 40000ms'));
      }
      if (code !== 0) {
        return reject(new Error(`Process exited with code ${code}`));
      }
      resolve(buf);
    });
  });
}

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

    const root = Path.resolve(ctx.workspaceDir);
    const tempPath = Path.join(process.cwd(), "temp", (Math.random() * 10000).toFixed(1) + ".sh");

    // ensure directories exist
    fs.mkdirSync(Path.join(process.cwd(), "temp"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(tempPath, script);
    process.stdout.write('running ' + script.slice(0, 500) + '\n');

    let result = ''
    const timeout = 40
    try {
      result = await runScriptAsync(`bash ${tempPath}`, root, timeout*1000);
    } catch (error: any) {
      if (error.code === 'ETIMEDOUT') {
        result = `[Command timed out after ${timeout} seconds]`
      } else {
        result = `[Command failed: ${error.message}]`
      }
    }
    return truncateResult(result, maxChars);
  },
};
