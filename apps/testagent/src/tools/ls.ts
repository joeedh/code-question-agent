import { readdir } from "node:fs/promises";
import { IGNORED_DIR_NAMES, resolveWorkspacePath, truncateResult, type Tool } from "./types.ts";
import { filterPath, filterCode } from "../config.ts";

export const lsTool: Tool = {
  name: "ls",
  description:
    "Lists the entries of a directory, non-recursively. Directories are suffixed with '/'.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list, relative to the workspace root. Defaults to the root.",
      },
    },
  },
  async run(input, ctx) {
    const { path: relPath } = input as { path?: string };
    const dir = resolveWorkspacePath(ctx.workspaceDir, relPath ?? ".");
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = entries
      .filter((entry) => !IGNORED_DIR_NAMES.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : filterPath(entry.name)))
      .sort();
    return truncateResult(lines.join("\n"));
  },
};
