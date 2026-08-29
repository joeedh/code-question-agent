import { readFile } from "node:fs/promises";
import { type Location } from "@code-question-agent/core";
import { fromFileUri } from "@code-question-agent/lsp-bridge";

export interface SnippetReader {
  /**
   * Returns the source lines from `location.line - contextLines` to `location.endLine +
   * contextLines`, clamped to the file. `startLine` and `location`'s own line numbers are
   * 0-indexed, matching the LSP convention `packages/core`'s `Location` carries through from
   * the daemon.
   */
  read(location: Location, contextLines: number): Promise<{ startLine: number; lines: string[] }>;
}

function toFsPath(file: string): string {
  return file.startsWith("file://") ? fromFileUri(file) : file;
}

export function createSnippetReader(): SnippetReader {
  const cache = new Map<string, string[]>();

  async function linesOf(file: string): Promise<string[]> {
    const cached = cache.get(file);
    if (cached) return cached;
    const text = await readFile(toFsPath(file), "utf8");
    const lines = text.split(/\r\n|\n/);
    cache.set(file, lines);
    return lines;
  }

  return {
    async read(location, contextLines) {
      const lines = await linesOf(location.file);
      const startLine = Math.max(0, location.line - contextLines);
      const endLine = Math.min(lines.length - 1, location.endLine + contextLines);
      return { startLine, lines: lines.slice(startLine, endLine + 1) };
    },
  };
}
