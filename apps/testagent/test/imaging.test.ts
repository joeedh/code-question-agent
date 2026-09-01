import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_BASE64_CHARS,
  MAX_LONG_EDGE,
  prepareImage,
  readImageSize,
  resetSharpCache,
  sniffMediaType,
} from "../src/imaging.ts";

/** Builds a PNG whose IHDR declares `width` by `height`, with `padding` bytes of body after it. */
function fakePng(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding)]);
}

function fakeGif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function fakeJpeg(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(20, 0);
  bytes.writeUInt16BE(0xffd8, 0);
  // An APP0 segment ahead of the frame header, so the marker walk has something to skip.
  bytes.writeUInt16BE(0xffe0, 2);
  bytes.writeUInt16BE(4, 4);
  bytes.writeUInt16BE(0xffc0, 8);
  bytes.writeUInt16BE(11, 10);
  bytes.writeUInt8(8, 12);
  bytes.writeUInt16BE(height, 13);
  bytes.writeUInt16BE(width, 15);
  return bytes;
}

function fakeWebp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32, 0);
  bytes.write("RIFF", 0, "ascii");
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

afterEach(() => {
  resetSharpCache();
});

describe("readImageSize", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readImageSize(fakePng(800, 600), "image/png")).toEqual({ width: 800, height: 600 });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    expect(readImageSize(fakeGif(64, 48), "image/gif")).toEqual({ width: 64, height: 48 });
  });

  it("reads JPEG dimensions from the frame header, skipping earlier segments", () => {
    expect(readImageSize(fakeJpeg(1920, 1080), "image/jpeg")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("reads WebP dimensions from a VP8X chunk", () => {
    expect(readImageSize(fakeWebp(300, 200), "image/webp")).toEqual({ width: 300, height: 200 });
  });

  it("returns undefined for a truncated header", () => {
    expect(readImageSize(Buffer.alloc(4), "image/png")).toBeUndefined();
  });
});

describe("sniffMediaType", () => {
  it("prefers the magic bytes over the extension", () => {
    expect(sniffMediaType(fakePng(1, 1), "screenshot.jpg")).toBe("image/png");
  });

  it("falls back to the extension when the magic bytes are unrecognized", () => {
    expect(sniffMediaType(Buffer.alloc(64), "diagram.webp")).toBe("image/webp");
  });

  it("rejects a file that is neither", () => {
    expect(() => sniffMediaType(Buffer.alloc(64), "notes.txt")).toThrow(/not a supported image/);
  });
});

describe("prepareImage", () => {
  it("passes a small image through as a base64 image block", async () => {
    const png = fakePng(100, 50, 128);
    const { block, note } = await prepareImage(png, "image/png", "small.png");
    expect(block.type).toBe("image");
    expect(block.source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(note).toContain("100x50");
    expect(note).not.toContain("downscaled");
  });

  it("downscales an oversized image to the long-edge cap", async () => {
    const sharp = (await import("sharp")).default;
    const wide = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const { block, note } = await prepareImage(wide, "image/png", "wide.png");
    expect(note).toContain("downscaled from 3000x1000");
    const data = block.source.type === "base64" ? block.source.data : "";
    const decoded = Buffer.from(data, "base64");
    expect(readImageSize(decoded, "image/png")).toEqual({ width: MAX_LONG_EDGE, height: 523 });
  });

  it("sends an oversized image unresized when sharp is unavailable", async () => {
    resetSharpCache(null);
    const { block, note } = await prepareImage(fakePng(4000, 100, 64), "image/png", "big.png");
    expect(note).toContain("sent unresized");
    expect(block.type).toBe("image");
  });

  it("refuses an image past the hard caps when sharp is unavailable", async () => {
    resetSharpCache(null);
    const huge = fakePng(200, 200, MAX_BASE64_CHARS);
    await expect(prepareImage(huge, "image/png", "huge.png")).rejects.toThrow(/too large to send/);
  });
});
