import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { type Effort, type ToolName } from "./config.ts";
import { elideImageData, type ToolOutput } from "./tools/types.ts";

export interface Transcript {
  appendTurn(role: "user" | "assistant", content: unknown, usage?: unknown): Promise<void>;
  appendToolCall(
    name: ToolName,
    input: unknown,
    output: ToolOutput,
    isError: boolean,
    callIndexForTool: number,
  ): Promise<void>;
  finalize(
    stopReason: string,
    totalTokens: number,
    callCounts: Record<string, number>,
    truncated: boolean,
  ): Promise<void>;
}

/**
 * Opens a new session transcript file under `<invocationCwd>/.testagent/` — always the
 * directory `pnpm testagent` was run from, never the (possibly different) workspace dir the
 * session inspects.
 */
export async function openTranscript(
  invocationCwd: string,
  meta: {
    workspaceDir: string;
    tools: ToolName[];
    model: string;
    effort: Effort;
    maxTokenBudget: number;
    toolLimits: Partial<Record<ToolName, number>>;
  },
): Promise<Transcript> {
  const dir = path.join(invocationCwd, ".testagent");
  await mkdir(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const filePath = path.join(
    dir,
    `session-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.jsonl`,
  );

  const write = (record: unknown) => appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");

  await write({ type: "session_start", startedAt, ...meta });

  return {
    async appendTurn(role, content, usage) {
      await write({ type: "turn", role, content, usage });
    },
    async appendToolCall(name, input, output, isError, callIndexForTool) {
      // Elided here rather than at the call site so no caller can write base64 into the log.
      const elided = elideImageData(output);
      await write({ type: "tool_call", name, input, output: elided, isError, callIndexForTool });
    },
    async finalize(stopReason, totalTokens, callCounts, truncated) {
      await write({
        type: "session_end",
        endedAt: new Date().toISOString(),
        stopReason,
        totalTokens,
        callCounts,
        truncated,
      });
    },
  };
}
