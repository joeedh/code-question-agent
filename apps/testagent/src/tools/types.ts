import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { type ToolName } from "../config.ts";

export interface ToolContext {
  workspaceDir: string;
  /** False when the session's model cannot read `image` blocks, refusing the tools that emit them. */
  visionCapable: boolean;
}

/** Block kinds a `tool_result` may carry back to the model. */
export type ToolBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;

/** A plain string for a text-only tool, or blocks for one that returns an image. */
export type ToolOutput = string | ToolBlock[];

export interface Tool {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Appends `note` to a tool's output, extending its trailing text block rather than adding
 * one so a single-image result keeps the image last.
 */
export function appendNote(output: ToolOutput, note: string): ToolOutput {
  if (note.length === 0) return output;
  if (typeof output === "string") return output + note;
  const blocks = [...output];
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    blocks[blocks.length - 1] = { ...last, text: last.text + note };
    return blocks;
  }
  blocks.push({ type: "text", text: note });
  return blocks;
}

/** Replaces every image block's base64 payload with a size summary, for logs and transcripts. */
export function elideImageData(output: ToolOutput): ToolOutput {
  if (typeof output === "string") return output;
  return output.map((block) => {
    if (block.type !== "image" || block.source.type !== "base64") return block;
    const kilobytes = Math.round((block.source.data.length * 3) / 4 / 1024);
    return {
      type: "text" as const,
      text: `[${block.source.media_type} image, ${kilobytes}KB base64 elided]`,
    };
  });
}

/** Flattens a tool result's content to one printable string, keeping base64 out of the console. */
export function describeToolOutput(
  content: string | readonly { type: string }[] | undefined,
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return (block as Anthropic.TextBlockParam).text;
      const source = (block as Anthropic.ImageBlockParam).source;
      if (block.type === "image" && source.type === "base64") {
        return `[${source.media_type} image, ${Math.round((source.data.length * 3) / 4 / 1024)}KB base64 elided]`;
      }
      return `[${block.type} block]`;
    })
    .join("\n");
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
