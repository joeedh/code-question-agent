import Anthropic from "@anthropic-ai/sdk";
import { type Effort, type TestAgentConfig, type ToolName } from "./config.ts";
import { formatTokenCount } from "./format.ts";
import { type Transcript } from "./transcript.ts";
import { TOOL_REGISTRY } from "./tools/registry.ts";
import { type ToolContext } from "./tools/types.ts";
import fs from 'node:fs'

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT: Effort = "high";
const MAX_TOKENS = 16000;

/** Prints one model turn's text/tool-use blocks and the running token count, e.g. `[tokens: 12.3k / 200k]`. */
export function printTurn(
  response: Anthropic.Message,
  tokensUsed: number,
  maxTokenBudget: number,
): void {
  for (const block of response.content) {
    if (block.type === "text") {
      process.stdout.write(block.text);
    } else if (block.type === "tool_use") {
      process.stdout.write(`\n→ ${block.name}(${JSON.stringify(block.input)})\n`);
    }
  }
  const budgetSuffix = maxTokenBudget === -1 ? "" : ` / ${formatTokenCount(maxTokenBudget)}`;
  process.stdout.write(`\n[tokens: ${formatTokenCount(tokensUsed)}${budgetSuffix}]\n`);
}

function buildToolDefs(tools: ToolName[]): Anthropic.Tool[] {
  return tools.map((name, index) => {
    const tool = TOOL_REGISTRY[name];
    const def: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
    };
    // One cache breakpoint on the last (static, session-long) tool definition.
    if (index === tools.length - 1) {
      def.cache_control = { type: "ephemeral" };
    }
    return def;
  });
}

/**
 * Tokens actually billed this turn: input + output + cache-write tokens. Excludes
 * `cache_read_input_tokens` — those were already paid for on an earlier turn, so neither the
 * running count nor `maxTokenBudget` should charge for them again.
 */
function usageTokens(usage: Anthropic.Usage): number {
  return usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens ?? 0);
}

export interface RunSessionOptions {
  client: Anthropic;
  config: TestAgentConfig;
  tools: ToolName[];
  systemPrompt: string;
  goal: string;
  workspaceDir: string;
  transcript: Transcript;
  /** Called once per model turn with the running (non-cached) token total. Defaults to `printTurn`. */
  onTurn?: (response: Anthropic.Message, tokensUsed: number, maxTokenBudget: number) => void;
}

/**
 * Drives the manual tool-call loop against the Messages API, enforcing per-tool call limits
 * and the session's token budget. Over-limit/over-budget tool calls get a refusal
 * `tool_result` rather than being silently dropped, so the model can react instead of stalling.
 */
export async function runSession(opts: RunSessionOptions): Promise<Anthropic.Message> {
  const { client, config, tools, systemPrompt, goal, workspaceDir, transcript } = opts;
  const onTurn = opts.onTurn ?? printTurn;
  const model = config.model ?? DEFAULT_MODEL;
  const effort = config.effort ?? DEFAULT_EFFORT;
  const toolDefs = buildToolDefs(tools);
  const ctx: ToolContext = { workspaceDir };

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: goal }];
  await transcript.appendTurn("user", goal);

  const callCounts: Record<string, number> = Object.fromEntries(tools.map((t) => [t, 0]));
  let tokensUsed = 0;
  let truncated = false;

  let lastMessage = '';

  for (;;) {
    const budgetExhausted = config.maxTokenBudget !== -1 && tokensUsed >= config.maxTokenBudget;
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: budgetExhausted ? [] : toolDefs,
      messages,
      thinking: model.search(/haiku/) === -1 ? { type: "adaptive" } : undefined,
      output_config: model.search(/haiku/) === -1 ? { effort } : undefined,
    });
    tokensUsed += usageTokens(response.usage);
    onTurn(response, tokensUsed, config.maxTokenBudget);
    await transcript.appendTurn("assistant", response.content, response.usage);
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      await transcript.finalize(
        response.stop_reason ?? "unknown",
        tokensUsed,
        callCounts,
        truncated,
      );
      if (lastMessage.length > 0) {
        fs.appendFileSync(`${workspaceDir}/finalTurns.md`, lastMessage + '\n\n====== End Turn ======\n\n');
      }
      return response;
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const name = block.name as ToolName;
      const limit = config.toolLimits[name] ?? -1;
      const overBudget = config.maxTokenBudget !== -1 && tokensUsed >= config.maxTokenBudget;
      const overLimit = limit !== -1 && callCounts[name]! >= limit;

      if (overBudget) {
        truncated = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "refused: session token budget exhausted",
          is_error: true,
        });
        continue;
      }
      if (overLimit) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `refused: ${name} call limit (${limit}) reached for this session`,
          is_error: true,
        });
        continue;
      }

      callCounts[name] = (callCounts[name] ?? 0) + 1;
      let limitMessage = ''
      if (limit !== -1 && callCounts[name]! >= Math.max(~~(limit*0.75), 0)) {
        limitMessage = `\n\n[you have ${limit-callCounts[name]!} ${name} calls remaining]`;
      }
      try {
        const output = (await TOOL_REGISTRY[name].run(block.input, ctx)) + limitMessage;
        lastMessage = output;
        await transcript.appendToolCall(name, block.input, output, false, callCounts[name]!);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await transcript.appendToolCall(name, block.input, message, true, callCounts[name]!);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: message + limitMessage,
          is_error: true,
        });
      }
    }

    console.log(toolResults.map((r) => r.content).join("\n"));
    messages.push({ role: "user", content: toolResults });
  }
}
