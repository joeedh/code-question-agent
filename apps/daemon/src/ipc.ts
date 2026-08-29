import { unlink } from "node:fs/promises";
import net from "node:net";
import {
  createMessageConnection,
  type MessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
} from "vscode-jsonrpc/node";
import {
  type QueryRequest,
  REQUEST_QUERY,
  REQUEST_SHUTDOWN,
  REQUEST_STATUS,
  type StatusResult,
} from "./protocol.ts";
import type { Report } from "@code-question-agent/core";

export interface RequestHandlers {
  status: () => Promise<StatusResult>;
  query: (request: QueryRequest) => Promise<Report>;
  shutdown: () => Promise<void>;
}

export interface IpcServer {
  address: string;
  close: () => Promise<void>;
}

/**
 * Connects to `address` to find out whether a daemon is actually listening there — the only
 * check this module trusts, since neither a stale `daemon.json` nor (on POSIX) a stale socket
 * file left behind by a force-killed process implies a live daemon.
 */
export async function isAddressLive(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function startIpcServer(
  address: string,
  handlers: RequestHandlers,
): Promise<IpcServer> {
  if (process.platform !== "win32") {
    // A named pipe leaves no filesystem trace once its owning process is gone, so this
    // cleanup only applies to a POSIX Unix domain socket file.
    if (await isAddressLive(address)) {
      throw new Error(`a daemon is already listening at ${address}`);
    }
    await unlink(address).catch(() => undefined);
  }

  const server = net.createServer((socket) => {
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    );
    connection.onRequest(REQUEST_STATUS, handlers.status);
    connection.onRequest(REQUEST_QUERY, handlers.query);
    connection.onRequest(REQUEST_SHUTDOWN, handlers.shutdown);
    connection.listen();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Connects as a client to a running daemon's IPC address — used by tests and, later, the CLI. */
export function connectIpc(address: string): Promise<MessageConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.once("connect", () => {
      const connection = createMessageConnection(
        new SocketMessageReader(socket),
        new SocketMessageWriter(socket),
      );
      connection.listen();
      resolve(connection);
    });
    socket.once("error", reject);
  });
}
