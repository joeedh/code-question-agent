import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printTurn } from "../src/agent.ts";

describe("printTurn", () => {
  let writes: string[];

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints text blocks and the running token count formatted compactly", () => {
    const response = {
      content: [{ type: "text", text: "hello", citations: null }],
    } as Anthropic.Message;

    printTurn(response, 100000, 200000);

    const output = writes.join("");
    expect(output).toContain("hello");
    expect(output).toContain("[tokens: 100k / 200k]");
  });

  it("announces a tool_use block with its name and input", () => {
    const response = {
      content: [{ type: "tool_use", id: "1", name: "grep", input: { pattern: "x" } }],
    } as Anthropic.Message;

    printTurn(response, 500, -1);

    const output = writes.join("");
    expect(output).toContain('→ grep({"pattern":"x"})');
    expect(output).toContain("[tokens: 500]");
    expect(output).not.toContain("/");
  });
});
