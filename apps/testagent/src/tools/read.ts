import { readFile } from "node:fs/promises";
import { resolveWorkspacePath, truncateResult, type Tool } from "./types.ts";
import { filterPath, filterCode } from "../config.ts";

const MAX_LINES = 2000;

export const readTool: Tool = {
  name: "read",
  description: "Reads a text file, optionally restricted to a line range (1-indexed, inclusive).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to read, relative to the workspace root." },
      startLine: {
        type: "integer",
        description: "First line to include, 1-indexed. Defaults to 1.",
      },
      endLine: {
        type: "integer",
        description: "Last line to include, 1-indexed. Defaults to the end of file.",
      },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const {
      path: relPath,
      startLine,
      endLine,
    } = input as {
      path: string;
      startLine?: number;
      endLine?: number;
    };
    const filePath = resolveWorkspacePath(ctx.workspaceDir, relPath);
    const raw = await readFile(filePath, "utf8");
    const allLines = filterCode(raw, filePath).split("\n");
    const start = Math.max(1, startLine ?? 1);
    const requestedEnd = Math.min(allLines.length, endLine ?? allLines.length);
    const cappedEnd = Math.min(requestedEnd, start + MAX_LINES - 1);
    const slice = allLines.slice(start - 1, cappedEnd);
    const body = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
    const suffix =
      cappedEnd < requestedEnd
        ? `\n[truncated, showing lines ${start}-${cappedEnd} of ${allLines.length}]`
        : "";
    return truncateResult(body + suffix);
  },
};
