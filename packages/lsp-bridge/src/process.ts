import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";
import {
  createProtocolConnection,
  type ProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";

export interface LspServerHandle {
  connection: ProtocolConnection;
  process: ChildProcessWithoutNullStreams;
  /** Resolves once the process has exited, after `dispose()` closes stdio. */
  exited: Promise<number | null>;
}

const NPM_EXECUTABLE_NAMES = process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];

/**
 * The server's own automatic type acquisition shells out to `npm install` on first use — this
 * tool never reads acquired `@types` (`documentSymbol`/`references` don't need them), and ATA
 * already handles a missing `npm` gracefully (logs and continues), so hiding `npm` from `PATH`
 * is what stops it. On Windows, this also avoids a console window ATA's `npm install` pops for
 * every LSP server start (a bug in `tsc --lsp`'s own `NpmInstall` callback, which doesn't set
 * `HideWindow`, not something this process can fix from the outside).
 */
function envWithoutNpm(): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  if (!pathKey) return process.env;
  const dirs = (process.env[pathKey] ?? "").split(path.delimiter);
  const withoutNpm = dirs.filter(
    (dir) => !NPM_EXECUTABLE_NAMES.some((name) => existsSync(path.join(dir, name))),
  );
  return { ...process.env, [pathKey]: withoutNpm.join(path.delimiter) };
}

/**
 * Whether `tscPath` is a Node script (an npm/pnpm-installed `typescript` package's `bin/tsc`
 * entry point, which re-execs the real per-platform native binary itself) rather than a
 * directly-executable binary. Windows never honors a shebang line the way POSIX does, so a
 * script-shaped `tscPath` has to be run as `node <tscPath>` there; detecting it and doing the
 * same on every platform keeps one code path.
 */
function needsNodeToRun(tscPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(tscPath, "r");
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(64);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0] ?? "";
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } finally {
    closeSync(fd);
  }
}

/** The command/args to launch `tscPath --lsp --stdio`, routing a Node-script `tscPath` through `node`. */
export function resolveSpawnCommand(tscPath: string): { command: string; args: string[] } {
  return needsNodeToRun(tscPath)
    ? { command: process.execPath, args: [tscPath, "--lsp", "--stdio"] }
    : { command: tscPath, args: ["--lsp", "--stdio"] };
}

/**
 * Spawns `tscPath --lsp --stdio` and wires a JSON-RPC connection to its
 * stdin/stdout using LSP's `Content-Length` framing.
 */
export function spawnLspServer(tscPath: string, cwd: string): LspServerHandle {
  const { command, args } = resolveSpawnCommand(tscPath);
  const childProcess = spawn(command, args, { cwd, env: envWithoutNpm() });

  const reader = new StreamMessageReader(childProcess.stdout);
  const writer = new StreamMessageWriter(childProcess.stdin);
  const connection = createProtocolConnection(reader, writer);
  connection.listen();

  const exited = new Promise<number | null>((resolve) => {
    childProcess.on("exit", (code) => resolve(code));
  });

  return { connection, process: childProcess, exited };
}
