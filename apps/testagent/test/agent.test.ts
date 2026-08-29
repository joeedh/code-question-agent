import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSession } from "../src/agent.ts";
import type { TestAgentConfig } from "../src/config.ts";
import type { Transcript } from "../src/transcript.ts";

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

function toolUseResponse(
  id: string,
  name: string,
  input: unknown,
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      ...usage,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

function fakeTranscript(): Transcript {
  return {
    appendTurn: async () => {},
    appendToolCall: async () => {},
    finalize: async () => {},
  };
}

describe("runSession", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-agent-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("refuses a tool call once its per-session limit is reached", async () => {
    const responses = [
      toolUseResponse("call1", "ls", {}),
      toolUseResponse("call2", "ls", {}),
      textResponse("done"),
    ];
    const requests: Anthropic.MessageCreateParams[] = [];
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          requests.push(structuredClone(params));
          return responses.shift()!;
        },
      },
    } as unknown as Anthropic;

    const config: TestAgentConfig = {
      enabledTools: ["ls"],
      toolLimits: { ls: 1 },
      maxTokenBudget: -1,
    };

    await runSession({
      client,
      config,
      tools: ["ls"],
      systemPrompt: "system",
      goal: "list files",
      workspaceDir,
      transcript: fakeTranscript(),
      onTurn: () => {},
    });

    // Third request carries the tool_result for the second (over-limit) call.
    const thirdRequestMessages = requests[2]!.messages;
    const lastMessage = thirdRequestMessages[thirdRequestMessages.length - 1]!;
    const toolResult = (lastMessage.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("call limit");
  });

  it("withholds tools once the token budget is exhausted", async () => {
    const responses = [
      toolUseResponse("call1", "ls", {}, { input_tokens: 50, output_tokens: 50 }),
      textResponse("wrapping up"),
    ];
    const requests: Anthropic.MessageCreateParams[] = [];
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          requests.push(structuredClone(params));
          return responses.shift()!;
        },
      },
    } as unknown as Anthropic;

    const config: TestAgentConfig = {
      enabledTools: ["ls"],
      toolLimits: { ls: -1 },
      maxTokenBudget: 100,
    };

    const response = await runSession({
      client,
      config,
      tools: ["ls"],
      systemPrompt: "system",
      goal: "list files",
      workspaceDir,
      transcript: fakeTranscript(),
      onTurn: () => {},
    });

    expect(response.content).toEqual([{ type: "text", text: "wrapping up", citations: null }]);
    expect(requests[1]!.tools).toEqual([]);
  });

  it("puts a cache_control breakpoint on the system prompt and the last tool", async () => {
    const requests: Anthropic.MessageCreateParams[] = [];
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          requests.push(params);
          return textResponse("done");
        },
      },
    } as unknown as Anthropic;

    const config: TestAgentConfig = {
      enabledTools: ["ls", "read"],
      toolLimits: { ls: -1, read: -1 },
      maxTokenBudget: -1,
    };

    await runSession({
      client,
      config,
      tools: ["ls", "read"],
      systemPrompt: "system",
      goal: "go",
      workspaceDir,
      transcript: fakeTranscript(),
      onTurn: () => {},
    });

    const [request] = requests;
    const system = request!.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    const tools = request!.tools as Anthropic.Tool[];
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: "ephemeral" });
  });
});
