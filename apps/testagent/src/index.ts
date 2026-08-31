#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_EFFORT, DEFAULT_MODEL, runSession } from "./agent.ts";
import { formatHelp, parseTestAgentArgs } from "./args.ts";
import { loadConfig, resolveToolSelection } from "./config.ts";
import { loadClaudeKey } from "./key.ts";
import { buildSystemPrompt } from "./systemPrompt.ts";
import { openTranscript } from "./transcript.ts";
import { loadGrepConfig } from "./tools/grep.ts";
export { formatHelp, parseTestAgentArgs, type TestAgentOptions } from "./args.ts";
export { loadConfig, resolveToolSelection, type TestAgentConfig } from "./config.ts";
export { loadClaudeKey } from "./key.ts";
export { runSession } from "./agent.ts";
import fs from 'node:fs'

async function main(): Promise<void> {
  const opts = parseTestAgentArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(formatHelp());
    return;
  }
  if (!opts.goal) {
    throw new Error("--goal is required");
  }

  const workspaceDir = opts.workspaceDir;

  fs.mkdirSync(workspaceDir, { recursive: true });
  
  const invocationCwd = process.cwd();
  const config = await loadConfig(workspaceDir, invocationCwd);
  loadGrepConfig(config);
  const tools = resolveToolSelection(opts.tools, config);
  const apiKey = await loadClaudeKey(invocationCwd);
  const client = new Anthropic({ apiKey });
  const systemPrompt = await buildSystemPrompt(workspaceDir, tools, config);
  const transcript = await openTranscript(invocationCwd, {
    workspaceDir,
    tools,
    model: config.model ?? DEFAULT_MODEL,
    effort: config.effort ?? DEFAULT_EFFORT,
    maxTokenBudget: config.maxTokenBudget,
    toolLimits: config.toolLimits,
  });

  // `runSession` already prints each turn's text (and the running token count) as it arrives.
  await runSession({
    client,
    config,
    tools,
    systemPrompt,
    goal: opts.goal,
    workspaceDir,
    transcript,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
