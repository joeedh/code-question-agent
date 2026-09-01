import { type ToolName } from "../config.ts";
import { cdpTool } from "./cdp.ts";
import { cliTool } from "./cli.ts";
import { grepTool } from "./grep.ts";
import { imageTool } from "./image.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { type Tool } from "./types.ts";
import { bashTool } from "./bash.ts";

export const TOOL_REGISTRY: Record<ToolName, Tool> = {
  cli: cliTool,
  grep: grepTool,
  read: readTool,
  ls: lsTool,
  cdp: cdpTool,
  bash: bashTool,
  image: imageTool,
};

export { resolveToolSelection } from "../config.ts";
