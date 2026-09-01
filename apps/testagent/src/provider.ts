import Anthropic from "@anthropic-ai/sdk";
import { loadClaudeKey, loadOpenRouterKey } from "./key.ts";

/**
 * Root of OpenRouter's Anthropic-compatible API, which accepts the same request shape the SDK
 * sends, tool definitions and `cache_control` breakpoints included. The SDK appends
 * `/v1/messages` itself, so this stops at `/api`.
 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

/** True for a model served through OpenRouter, whose id is `<vendor>/<name>` (`z-ai/glm-5.3-flash`). */
export function isOpenRouterModel(model: string): boolean {
  return model.includes("/");
}

/** Builds the client for `model`, reading whichever key under `<repoRoot>/keys` its provider needs. */
export async function createClient(model: string, repoRoot: string): Promise<Anthropic> {
  if (isOpenRouterModel(model)) {
    return new Anthropic({
      apiKey: await loadOpenRouterKey(repoRoot),
      baseURL: OPENROUTER_BASE_URL,
    });
  }
  return new Anthropic({ apiKey: await loadClaudeKey(repoRoot) });
}
