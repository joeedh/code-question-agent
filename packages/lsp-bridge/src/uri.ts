import { fileURLToPath, pathToFileURL } from "node:url";

const WIN32_DRIVE = /^file:\/\/\/([A-Za-z]):/;
const WIN32_DRIVE_ENCODED = /^file:\/\/\/([a-z])%3A/;

/**
 * Converts a filesystem path to the `file://` form the TypeScript LSP server
 * itself uses. On Windows the server lowercases the drive letter and
 * percent-encodes its colon (`file:///c%3A/foo`), which does not string-equal
 * `require("node:url").pathToFileURL`'s output (`file:///C:/foo`).
 */
export function toFileUri(filePath: string): string {
  const href = pathToFileURL(filePath).href;
  return href.replace(WIN32_DRIVE, (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`);
}

/** Inverse of {@link toFileUri}. */
export function fromFileUri(uri: string): string {
  const restored = uri.replace(
    WIN32_DRIVE_ENCODED,
    (_match, drive: string) => `file:///${drive.toUpperCase()}:`,
  );
  return fileURLToPath(restored);
}
