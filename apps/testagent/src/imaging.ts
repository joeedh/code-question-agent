import type Anthropic from "@anthropic-ai/sdk";

/** Media types the Messages API accepts in an `image` block. */
export const SUPPORTED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

const EXTENSION_MEDIA_TYPES: Record<string, SupportedMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Long edge beyond which the API scales an image down itself and bills the scaled size, so
 * uploading anything larger only costs bandwidth.
 */
export const MAX_LONG_EDGE = 1568;

/** Hard per-image dimension cap, above which the API rejects the request. */
export const MAX_EDGE = 8000;

/** Hard per-image payload cap, held under the API's 5MB with room for the JSON envelope. */
export const MAX_BASE64_CHARS = 4_500_000;

/** Estimates an image's token cost from Anthropic's `width * height / 750` rule. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

export interface ImageSize {
  width: number;
  height: number;
}

function readPngSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 24) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readGifSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** Frame-header marker codes carrying dimensions, excluding the non-frame `0xc4`/`0xc8`/`0xcc`. */
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpegSize(bytes: Buffer): ImageSize | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Padding and the standalone markers carry no length field to skip over.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

function readWebpSize(bytes: Buffer): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  }
  return undefined;
}

/** Reads pixel dimensions out of the container header, without decoding the pixels. */
export function readImageSize(bytes: Buffer, mediaType: SupportedMediaType): ImageSize | undefined {
  switch (mediaType) {
    case "image/png":
      return readPngSize(bytes);
    case "image/jpeg":
      return readJpegSize(bytes);
    case "image/gif":
      return readGifSize(bytes);
    case "image/webp":
      return readWebpSize(bytes);
  }
}

function sniffMagic(bytes: Buffer): SupportedMediaType | undefined {
  if (bytes.length >= 8 && bytes.toString("hex", 0, 8) === "89504e470d0a1a0a") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Identifies an image's media type from its magic bytes, falling back to the extension of
 * `label`. Throws when neither names a type the API accepts.
 */
export function sniffMediaType(bytes: Buffer, label: string): SupportedMediaType {
  const magic = sniffMagic(bytes);
  if (magic) return magic;
  const dot = label.lastIndexOf(".");
  const byExtension =
    dot === -1 ? undefined : EXTENSION_MEDIA_TYPES[label.slice(dot).toLowerCase()];
  if (byExtension) return byExtension;
  throw new Error(`${label} is not a supported image (${SUPPORTED_MEDIA_TYPES.join(", ")} only)`);
}

type SharpConstructor = (typeof import("sharp"))["default"];
let sharpModule: SharpConstructor | null | undefined;

/**
 * Resolves `sharp` once per process, yielding `null` when it is absent or its native binding
 * fails to load. Resizing is skipped in that case rather than aborting the session.
 */
export async function loadSharp(): Promise<SharpConstructor | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    sharpModule = (await import("sharp")).default;
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

/** Discards the memoized `loadSharp` result so a test can substitute its own outcome. */
export function resetSharpCache(value?: SharpConstructor | null): void {
  sharpModule = value === undefined ? undefined : value;
}

export interface PreparedImage {
  block: Anthropic.ImageBlockParam;
  /** Media type, final dimensions, payload size, and any downscale that was applied. */
  note: string;
}

function imageBlock(bytes: Buffer, mediaType: SupportedMediaType): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
  };
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function describe(
  mediaType: SupportedMediaType,
  size: ImageSize | undefined,
  bytes: Buffer,
): string {
  const dims = size ? `${size.width}x${size.height}` : "unknown size";
  const tokens = size ? `, ~${estimateImageTokens(size.width, size.height)} tokens` : "";
  return `${mediaType} ${dims}, ${Math.round(bytes.length / 1024)}KB${tokens}`;
}

function sharpFormat(mediaType: SupportedMediaType): "jpeg" | "png" | "webp" {
  if (mediaType === "image/jpeg") return "jpeg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

/**
 * Downscales an oversized image and wraps it as an `image` block. Without `sharp` an image
 * under the API's hard caps is passed through unresized, and one above them is refused with
 * the install instruction, since sending it would fail the request mid-session.
 */
export async function prepareImage(
  input: Buffer,
  mediaType: SupportedMediaType,
  label: string,
): Promise<PreparedImage> {
  const original = readImageSize(input, mediaType);
  const overLongEdge =
    original !== undefined && Math.max(original.width, original.height) > MAX_LONG_EDGE;
  const overPayload = base64Length(input.length) > MAX_BASE64_CHARS;

  if (!overLongEdge && !overPayload) {
    return {
      block: imageBlock(input, mediaType),
      note: `${label}: ${describe(mediaType, original, input)}`,
    };
  }

  const sharp = await loadSharp();
  if (!sharp) {
    const overHardCap =
      overPayload ||
      (original !== undefined && Math.max(original.width, original.height) > MAX_EDGE);
    if (overHardCap) {
      throw new Error(
        `${label} is too large to send (${describe(mediaType, original, input)}; the caps are ` +
          `${MAX_EDGE}px and ${Math.round(MAX_BASE64_CHARS / 1024)}KB of base64) and sharp is ` +
          `not installed to resize it. Run \`pnpm --filter @code-question-agent/testagent add sharp\`.`,
      );
    }
    return {
      block: imageBlock(input, mediaType),
      note:
        `${label}: ${describe(mediaType, original, input)} (sent unresized; install sharp to ` +
        `downscale to ${MAX_LONG_EDGE}px before upload)`,
    };
  }

  // Writing GIF needs a libvips built with gif support, so a GIF source lands as PNG.
  const outputType: SupportedMediaType = mediaType === "image/gif" ? "image/png" : mediaType;
  let longEdge = MAX_LONG_EDGE;
  let bytes = input;
  let size = original;
  for (let attempt = 0; attempt < 4; attempt++) {
    const resized = await sharp(input, { animated: false })
      .resize({ width: longEdge, height: longEdge, fit: "inside", withoutEnlargement: true })
      .toFormat(sharpFormat(outputType), { quality: 80 })
      .toBuffer({ resolveWithObject: true });
    bytes = resized.data;
    size = { width: resized.info.width, height: resized.info.height };
    if (base64Length(bytes.length) <= MAX_BASE64_CHARS) break;
    longEdge = Math.max(64, Math.round(longEdge / 2));
  }

  if (base64Length(bytes.length) > MAX_BASE64_CHARS) {
    throw new Error(
      `${label} stayed above the ${MAX_BASE64_CHARS}-char payload cap after resizing`,
    );
  }

  const from = original ? `${original.width}x${original.height}` : "an unknown size";
  return {
    block: imageBlock(bytes, outputType),
    note: `${label}: ${describe(outputType, size, bytes)} (downscaled from ${from})`,
  };
}
