import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIR_NAMES, resolveWorkspacePath, truncateResult, type Tool } from "./types.ts";
import type { TestAgentConfig } from "../config.ts";
import { skipPath, filterCode } from "../config.ts";
import { fileCache } from "../utils.ts";

const MAX_CONTEXT_LINES = 25;

let grepConfig = [] as RegExp[];

const dirCache = new Map<string, { name: string; isDirectory: boolean; isFile: boolean }[]>();

function globToRe(glob: string) {
  glob = glob
    .replace(/\./g, "\\.") //
    .replace(/\*\*/g, "::T::")
    .replace(/\*/g, "[^/]*")
    .replace(/::T::/g, ".*");

  glob = `^${glob}$`;
  return glob;
}

export function loadGrepConfig(config: TestAgentConfig) {
  grepConfig = (config.grepExclude ?? []).map((s) => new RegExp(globToRe(s)));
}

async function readdirWithCache(dir: string) {
  if (dirCache.has(dir)) {
    return dirCache.get(dir)!;
  }
  const result = await readdir(dir, { withFileTypes: true });
  dirCache.set(
    dir,
    result.map((entry) => {
      return { name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() };
    }),
  );
  return dirCache.get(dir)!;
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdirWithCache(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (grepConfig.find((g) => g.test(full.replace(/\\/g, "/")))) {
      continue;
    }

    if (entry.isDirectory) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile && !skipPath(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

interface Match {
  file: string;
  line: number;
  contextStart: number;
  lines: string[];
}

/** Grep tool: recursive by default, a path filter, and context lines capped at `MAX_CONTEXT_LINES`. */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Searches file contents for a pattern (regexp), recursively from a path. Reports matches " +
    `with surrounding context lines (capped at ${MAX_CONTEXT_LINES} above/below).`,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regexp pattern to search for." },
      path: {
        type: "string",
        description:
          "File or directory to search, relative to the workspace root. Defaults to the root.",
      },
      contextLines: {
        type: "integer",
        description: `Lines of context above/below each match (0-${MAX_CONTEXT_LINES}, default 0).`,
      },
    },
    required: ["pattern"],
  },
  async run(input, ctx) {
    const {
      pattern,
      path: relPath,
      contextLines,
    } = input as {
      pattern: string;
      path?: string;
      contextLines?: number;
    };
    const context = Math.max(0, Math.min(MAX_CONTEXT_LINES, contextLines ?? 0));
    const regexp = new RegExp(pattern);

    const root = resolveWorkspacePath(ctx.workspaceDir, relPath ?? ".");

    const stat = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    const files = stat !== undefined ? await collectFiles(root) : [root];

    const matches: Match[] = [];
    for (const file of files) {
      let content: string;

      if (fileCache.has(file)) {
        content = fileCache.get(file)!;
      } else {
        try {
          content = await readFile(file, "utf8");
        } catch {
          console.log("read error", file);
          continue;
        }
        content = filterCode(content, file);
        fileCache.set(file, content);
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regexp.test(lines[i]!)) {
          const contextStart = Math.max(0, i - context);
          const contextEnd = Math.min(lines.length - 1, i + context);
          matches.push({
            file: path.relative(ctx.workspaceDir, file),
            line: i + 1,
            contextStart: contextStart + 1,
            lines: lines.slice(contextStart, contextEnd + 1),
          });
        }
      }
    }

    if (matches.length === 0) return "no matches";
    let lastfile = "";

    const blocks = matches.map((match) => {
      let body = match.lines.map((line, i) => `  ${match.contextStart + i}: ${line}`).join("\n");
      if (lastfile !== match.file) {
        lastfile = match.file;
        body = `\n${match.file}:\n${body}`;
      }
      return body;
    });
    return truncateResult(blocks.join("\n"));
  },
};
