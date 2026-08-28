import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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

/**
 * Spawns `tscPath --lsp --stdio` and wires a JSON-RPC connection to its
 * stdin/stdout using LSP's `Content-Length` framing.
 */
export function spawnLspServer(tscPath: string, cwd: string): LspServerHandle {
  const process = spawn(tscPath, ["--lsp", "--stdio"], { cwd });

  const reader = new StreamMessageReader(process.stdout);
  const writer = new StreamMessageWriter(process.stdin);
  const connection = createProtocolConnection(reader, writer);
  connection.listen();

  const exited = new Promise<number | null>((resolve) => {
    process.on("exit", (code) => resolve(code));
  });

  return { connection, process, exited };
}
