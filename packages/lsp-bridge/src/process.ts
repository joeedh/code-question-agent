import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
 * Spawns `tscPath --lsp --stdio` and wires a JSON-RPC connection to its
 * stdin/stdout using LSP's `Content-Length` framing.
 */
export function spawnLspServer(tscPath: string, cwd: string): LspServerHandle {
  const process = spawn(tscPath, ["--lsp", "--stdio"], { cwd, env: envWithoutNpm() });

  const reader = new StreamMessageReader(process.stdout);
  const writer = new StreamMessageWriter(process.stdin);
  const connection = createProtocolConnection(reader, writer);
  connection.listen();

  const exited = new Promise<number | null>((resolve) => {
    process.on("exit", (code) => resolve(code));
  });

  return { connection, process, exited };
}
