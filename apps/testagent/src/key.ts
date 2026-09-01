import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadKey(repoRoot: string, fileName: string, description: string): Promise<string> {
  const keyPath = path.join(repoRoot, "keys", fileName);
  let raw: string;
  try {
    raw = await readFile(keyPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${description} from ${keyPath}. Create this file (gitignored) ` +
        `containing the key. See docs/testagent.md.`,
      { cause: error },
    );
  }
  const key = raw.trim();
  if (!key) throw new Error(`${keyPath} is empty`);
  return key;
}

/** Reads the Anthropic API key from `<repoRoot>/keys/claude.txt` (this repo's root, gitignored). */
export async function loadClaudeKey(repoRoot: string): Promise<string> {
  return loadKey(repoRoot, "claude.txt", "an Anthropic API key");
}

/** Reads the OpenRouter API key from `<repoRoot>/keys/openrouter.txt` (this repo's root, gitignored). */
export async function loadOpenRouterKey(repoRoot: string): Promise<string> {
  return loadKey(repoRoot, "openrouter.txt", "an OpenRouter API key");
}
