import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageTool } from "../../src/tools/image.ts";
import {
  appendNote,
  describeToolOutput,
  elideImageData,
  type ToolBlock,
} from "../../src/tools/types.ts";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("imageTool", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "testagent-image-"));
    await writeFile(path.join(workspaceDir, "shot.png"), PNG_1PX);
    await writeFile(path.join(workspaceDir, "notes.txt"), "not an image");
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns an image block followed by a describing text block", async () => {
    const output = (await imageTool.run(
      { path: "shot.png" },
      { workspaceDir, visionCapable: true },
    )) as ToolBlock[];
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect(output[1]).toMatchObject({ type: "text" });
    expect(describeToolOutput(output)).toContain("shot.png: image/png 1x1");
  });

  it("refuses when the session's model cannot read images", async () => {
    await expect(
      imageTool.run({ path: "shot.png" }, { workspaceDir, visionCapable: false }),
    ).rejects.toThrow(/cannot read images/);
  });

  it("rejects a path outside the workspace", async () => {
    await expect(
      imageTool.run({ path: "../escape.png" }, { workspaceDir, visionCapable: true }),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("rejects a file that is not an image", async () => {
    await expect(
      imageTool.run({ path: "notes.txt" }, { workspaceDir, visionCapable: true }),
    ).rejects.toThrow(/not a supported image/);
  });
});

describe("elideImageData", () => {
  it("replaces base64 payloads with a size summary", () => {
    const output: ToolBlock[] = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(4096) },
      },
      { type: "text", text: "shot.png" },
    ];
    const elided = elideImageData(output) as ToolBlock[];
    expect(JSON.stringify(elided)).not.toContain("AAAA");
    expect(elided[0]).toMatchObject({ type: "text", text: "[image/png image, 3KB base64 elided]" });
    expect(elided[1]).toEqual({ type: "text", text: "shot.png" });
  });

  it("leaves a string result untouched", () => {
    expect(elideImageData("plain output")).toBe("plain output");
  });
});

describe("appendNote", () => {
  it("appends to a string result", () => {
    expect(appendNote("body", " [note]")).toBe("body [note]");
  });

  it("extends the trailing text block rather than adding one", () => {
    const output: ToolBlock[] = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
      { type: "text", text: "shot.png" },
    ];
    const noted = appendNote(output, " [note]") as ToolBlock[];
    expect(noted).toHaveLength(2);
    expect(noted[1]).toMatchObject({ type: "text", text: "shot.png [note]" });
  });

  it("adds a text block when the result ends with an image", () => {
    const output: ToolBlock[] = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } },
    ];
    expect(appendNote(output, "[note]")).toHaveLength(2);
  });

  it("returns the output unchanged for an empty note", () => {
    const output: ToolBlock[] = [{ type: "text", text: "body" }];
    expect(appendNote(output, "")).toBe(output);
  });
});
