import { type StatusResult } from "@code-question-agent/daemon";
import { type MessageConnection } from "vscode-jsonrpc/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliOptions } from "../src/args.ts";
import { waitForIndexing } from "../src/connection.ts";

function baseOpts(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    help: false,
    llmHelp: false,
    query: "greet",
    regexp: false,
    whatRefs: false,
    includeClassTrace: false,
    contextLines: 0,
    includeLine: true,
    excludeColumn: false,
    json: false,
    noWait: false,
    timeoutMs: 10_000,
    verbose: false,
    ...overrides,
  };
}

/** Returns each of `responses` in order via `sendRequest`, repeating the last one past the end. */
function stubConnection(responses: StatusResult[]): {
  connection: MessageConnection;
  callCount: () => number;
} {
  let calls = 0;
  const connection = {
    sendRequest: async () => {
      const status = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return status;
    },
  } as unknown as MessageConnection;
  return { connection, callCount: () => calls };
}

const stillIndexing = (filesIndexed: number, filesTotal: number): StatusResult => ({
  pid: 1,
  repoRoot: "/repo",
  startedAt: "now",
  indexing: true,
  filesIndexed,
  filesTotal,
});

const doneIndexing = (filesTotal: number): StatusResult => ({
  pid: 1,
  repoRoot: "/repo",
  startedAt: "now",
  indexing: false,
  filesIndexed: filesTotal,
  filesTotal,
});

describe("waitForIndexing", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("skips entirely with --no-wait", async () => {
    const { connection, callCount } = stubConnection([stillIndexing(0, 2)]);
    await waitForIndexing(connection, baseOpts({ noWait: true }));
    expect(callCount()).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns immediately when the daemon isn't indexing", async () => {
    const { connection, callCount } = stubConnection([doneIndexing(2)]);
    await waitForIndexing(connection, baseOpts());
    expect(callCount()).toBe(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("prints a one-time notice without -v", async () => {
    const { connection } = stubConnection([
      stillIndexing(0, 2),
      stillIndexing(1, 2),
      doneIndexing(2),
    ]);
    await waitForIndexing(connection, baseOpts());
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("indexing…");
  });

  it("prints file-count progress with -v's scan tag enabled", async () => {
    const { connection } = stubConnection([
      stillIndexing(0, 2),
      stillIndexing(1, 2),
      doneIndexing(2),
    ]);
    await waitForIndexing(connection, baseOpts({ verbose: true }));
    expect(errorSpy.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "[scan] indexing… 0/2 files",
      "[scan] indexing… 1/2 files",
      "[scan] indexing… 2/2 files",
    ]);
  });

  it("stays silent on scan progress when -v is scoped to a different tag", async () => {
    const { connection } = stubConnection([stillIndexing(0, 2), doneIndexing(2)]);
    await waitForIndexing(connection, baseOpts({ verbose: true, verboseTags: ["daemon"] }));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("indexing…");
  });

  it("gives up and reports still-indexing once the timeout passes", async () => {
    const { connection } = stubConnection([stillIndexing(0, 2)]);
    await waitForIndexing(connection, baseOpts({ timeoutMs: -1 }));
    expect(errorSpy).toHaveBeenCalledWith(
      "still indexing after the timeout — answering from the index as it stands.",
    );
  });
});
