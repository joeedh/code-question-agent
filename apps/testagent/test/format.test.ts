import { describe, expect, it } from "vitest";
import { formatTokenCount } from "../src/format.ts";

describe("formatTokenCount", () => {
  it("prints small counts as plain integers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("prints round thousands without a decimal", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(100000)).toBe("100k");
  });

  it("prints a one-decimal suffix for non-round thousands", () => {
    expect(formatTokenCount(12345)).toBe("12.3k");
    expect(formatTokenCount(1050)).toBe("1.1k");
  });
});
