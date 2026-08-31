import path from "node:path";
import { type ToolName } from "../config.ts";

export interface ToolContext {
  workspaceDir: string;
}

export interface Tool {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

/** Names shared across `grep`/`read`/`ls` for a top-level directory they should never descend into. */
export const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", ".git", ".testagent"]);

/**
 * Resolves `userPath` against `workspaceDir`, rejecting an absolute path or a `..` escape out
 * of the workspace root.
 */
export function resolveWorkspacePath(workspaceDir: string, userPath: string): string {
  if (path.isAbsolute(userPath)) {
    throw new Error(`path must be relative to the workspace, got an absolute path: ${userPath}`);
  }
  const resolved = path.resolve(workspaceDir, userPath);
  const root = path.resolve(workspaceDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace directory: ${userPath}`);
  }
  return resolved;
}

const MAX_RESULT_CHARS = 20_000;

/** Truncates `text` to `maxChars`, protecting the session's token budget from one huge result. */
export function truncateResult(text: string, maxChars = MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated, ${text.length} total chars]`;
}
