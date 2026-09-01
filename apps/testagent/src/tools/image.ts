import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareImage, sniffMediaType, SUPPORTED_MEDIA_TYPES } from "../imaging.ts";
import { resolveWorkspacePath, type Tool, type ToolBlock } from "./types.ts";

export const imageTool: Tool = {
  name: "image",
  description:
    `Views an image file from the workspace (${SUPPORTED_MEDIA_TYPES.join(", ")}) and returns ` +
    "it for you to look at directly. Use it for screenshots, diagrams, and rendered output " +
    "that `read` cannot show, not for text files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Image file to view, relative to the workspace root." },
    },
    required: ["path"],
  },
  async run(input, ctx) {
    const { path: relPath } = input as { path: string };
    if (!ctx.visionCapable) {
      throw new Error("refused: this session's model cannot read images");
    }
    const filePath = resolveWorkspacePath(ctx.workspaceDir, relPath);
    const bytes = await readFile(filePath);
    const mediaType = sniffMediaType(bytes, filePath);
    const { block, note } = await prepareImage(bytes, mediaType, path.basename(filePath));
    const blocks: ToolBlock[] = [block, { type: "text", text: note }];
    return blocks;
  },
};
