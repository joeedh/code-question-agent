import { readFile } from "node:fs/promises";
import path from "node:path";

/** Reads the Anthropic API key from `<repoRoot>/keys/claude.txt` (this repo's root, gitignored). */
export async function loadClaudeKey(repoRoot: string): Promise<string> {
  const keyPath = path.join(repoRoot, "keys", "claude.txt");
  let raw: string;
  try {
    raw = await readFile(keyPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read an Anthropic API key from ${keyPath}. Create this file (gitignored) ` +
        `containing your Claude API key. See docs/testagent.md.`,
      { cause: error },
    );
  }
  const key = raw.trim();
  if (!key) throw new Error(`${keyPath} is empty`);
  return key;
}
