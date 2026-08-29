import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectIpc, isAddressLive, startIpcServer } from "../src/ipc.ts";
import { REQUEST_QUERY, REQUEST_STATUS } from "../src/protocol.ts";

function testAddress(dir: string, name: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\code-question-agent-test-${name}-${process.pid}`;
  }
  return path.join(dir, `${name}.sock`);
}

describe("ipc", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "code-question-agent-ipc-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a status request over the real transport", async () => {
    const address = testAddress(dir, "status");
    const server = await startIpcServer(address, {
      status: async () => ({ pid: 123, repoRoot: "/repo", startedAt: "now", indexing: false }),
      query: async () => {
        throw new Error("not used in this test");
      },
      shutdown: async () => undefined,
    });

    try {
      const client = await connectIpc(address);
      const status = await client.sendRequest(REQUEST_STATUS);
      expect(status).toEqual({ pid: 123, repoRoot: "/repo", startedAt: "now", indexing: false });
      client.dispose();
    } finally {
      await server.close();
    }
  });

  it("round-trips a query request, passing the request through to the handler", async () => {
    const address = testAddress(dir, "query");
    const received: unknown[] = [];
    const server = await startIpcServer(address, {
      status: async () => {
        throw new Error("not used in this test");
      },
      query: async (request) => {
        received.push(request);
        return {
          type: "symbol-info",
          id: "1",
          title: "t",
          content: "c",
          query: request.query,
          info: "",
          symbols: [],
        };
      },
      shutdown: async () => undefined,
    });

    try {
      const client = await connectIpc(address);
      const request = {
        query: { type: "symbol-query", symbol: "foo" },
        report: "symbol-info" as const,
      };
      const report = await client.sendRequest(REQUEST_QUERY, request);
      expect(received).toEqual([request]);
      expect(report).toMatchObject({ type: "symbol-info" });
      client.dispose();
    } finally {
      await server.close();
    }
  });

  it("reports an address with nothing listening as not live", async () => {
    const address = testAddress(dir, "nobody-home");
    const live = await isAddressLive(address);
    expect(live).toBe(false);
  });

  it("refuses to start a second server on an address already served", async () => {
    const address = testAddress(dir, "already-served");
    const server = await startIpcServer(address, {
      status: async () => ({ pid: 1, repoRoot: "/repo", startedAt: "now", indexing: false }),
      query: async () => {
        throw new Error("not used");
      },
      shutdown: async () => undefined,
    });

    try {
      await expect(
        startIpcServer(address, {
          status: async () => ({ pid: 2, repoRoot: "/repo", startedAt: "now", indexing: false }),
          query: async () => {
            throw new Error("not used");
          },
          shutdown: async () => undefined,
        }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "recovers from a stale Unix socket file left behind by a killed process",
    async () => {
      const address = testAddress(dir, "stale");
      // Simulate a force-killed daemon: a socket file on disk with nothing listening.
      await writeFile(address, "");

      const server = await startIpcServer(address, {
        status: async () => ({ pid: 1, repoRoot: "/repo", startedAt: "now", indexing: false }),
        query: async () => {
          throw new Error("not used");
        },
        shutdown: async () => undefined,
      });

      try {
        const client = await connectIpc(address);
        const status = await client.sendRequest(REQUEST_STATUS);
        expect(status).toMatchObject({ pid: 1 });
        client.dispose();
      } finally {
        await server.close();
      }
    },
  );
});
