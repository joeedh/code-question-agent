import type { Position } from "vscode-languageserver-protocol/node";

function offsetToPosition(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return { line: lines.length - 1, character: lastLine.length };
}

/** Finds the `occurrence`-th (0-indexed) match of `needle` and returns its LSP position. */
export function positionOf(text: string, needle: string, occurrence = 0): Position {
  let index = -1;
  for (let i = 0; i <= occurrence; i++) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) {
      throw new Error(`occurrence ${occurrence} of "${needle}" not found`);
    }
  }
  return offsetToPosition(text, index);
}
