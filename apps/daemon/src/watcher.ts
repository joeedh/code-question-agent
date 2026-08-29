import { spawn } from "node:child_process";
import path from "node:path";
import chokidar from "chokidar";

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoRoot });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
}

function gitStdin(repoRoot: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: repoRoot });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    child.stdin.end(input);
  });
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/** The cold-start file list: already gitignore-aware, so no separate ignore-matching pass is needed. */
export async function listTrackedFiles(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((relative) => path.join(repoRoot, relative));
}

/**
 * Filters watcher-reported paths through `git check-ignore --stdin` in one batched call
 * rather than a bundled ignore-pattern library, per `docs/plans/03-daemon-implementation.md` —
 * `git` stays the single source of truth for ignore rules across the whole codebase (also used
 * by `packages/db/src/checkpoint.ts`).
 */
export async function filterIgnored(repoRoot: string, absolutePaths: string[]): Promise<string[]> {
  if (absolutePaths.length === 0) return [];
  const pairs = absolutePaths.map(
    (absolutePath) => [absolutePath, toPosix(path.relative(repoRoot, absolutePath))] as const,
  );
  const stdout = await gitStdin(
    repoRoot,
    ["check-ignore", "--stdin"],
    `${pairs.map(([, relative]) => relative).join("\n")}\n`,
  );
  const ignored = new Set(stdout.split("\n").filter((line) => line.length > 0));
  return pairs
    .filter(([, relative]) => !ignored.has(relative))
    .map(([absolutePath]) => absolutePath);
}

export interface WatcherHandlers {
  onFileChanged: (absolutePath: string) => void;
  onFileRemoved: (absolutePath: string) => void;
  onReflogChanged: () => void;
}

export interface RepoWatcher {
  close: () => Promise<void>;
}

function debouncer(delayMs: number) {
  const pending = new Map<string, NodeJS.Timeout>();
  return (key: string, run: () => void): void => {
    const existing = pending.get(key);
    if (existing) clearTimeout(existing);
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        run();
      }, delayMs),
    );
  };
}

/**
 * Directories that never hold source this tool indexes, skipped before an event is even
 * raised. `filterIgnored` still decides correctness; this only keeps a dependency install or
 * a build from queueing tens of thousands of paths it would have discarded anyway.
 */
const NEVER_WATCHED = /(^|[/\\])(\.git|node_modules)([/\\]|$)/;

/**
 * Watches the tracked source tree (via `chokidar`, `NEVER_WATCHED` excluded) and, separately, the
 * reflog (`.git/logs/HEAD`) — appended to on every ref update (commit, checkout, merge,
 * rebase) — as the checkpoint-capture trigger, avoiding a git hook this tool doesn't own.
 */
export function watchRepo(
  repoRoot: string,
  handlers: WatcherHandlers,
  debounceMs = 150,
): RepoWatcher {
  const debounce = debouncer(debounceMs);
  const reflogPath = path.join(repoRoot, ".git", "logs", "HEAD");

  const sourceWatcher = chokidar.watch(repoRoot, {
    ignored: NEVER_WATCHED,
    ignoreInitial: true,
    persistent: true,
  });

  const changed = new Set<string>();
  const removed = new Set<string>();
  let flushTimer: NodeJS.Timeout | undefined;
  // Flushes run end to end so a batch can't overlap the next one and double the git processes
  // in flight; `close` awaits this to avoid dispatching into a torn-down daemon.
  let flushing: Promise<void> = Promise.resolve();

  async function flush(): Promise<void> {
    const batch = [...changed];
    const gone = [...removed];
    changed.clear();
    removed.clear();
    for (const filePath of gone) handlers.onFileRemoved(filePath);
    if (batch.length === 0) return;
    const kept = await filterIgnored(repoRoot, batch).catch(() => [] as string[]);
    for (const filePath of kept) handlers.onFileChanged(filePath);
  }

  /**
   * Debounces ahead of `filterIgnored` rather than after it. Filtering spawns a `git
   * check-ignore` per call, so reacting per event spawned one process per file written — a
   * build or an install landed thousands at once. Coalescing first makes a storm cost one
   * batched spawn, and the quiet period means none at all while it is still being written.
   */
  function schedule(): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushing = flushing.then(flush, flush);
    }, debounceMs);
  }

  function record(filePath: string): void {
    removed.delete(filePath);
    changed.add(filePath);
    schedule();
  }

  sourceWatcher.on("add", record);
  sourceWatcher.on("change", record);
  sourceWatcher.on("unlink", (filePath: string) => {
    changed.delete(filePath);
    removed.add(filePath);
    schedule();
  });

  const reflogWatcher = chokidar.watch(reflogPath, { ignoreInitial: true, persistent: true });
  reflogWatcher.on("add", () => debounce(reflogPath, handlers.onReflogChanged));
  reflogWatcher.on("change", () => debounce(reflogPath, handlers.onReflogChanged));

  return {
    close: async () => {
      if (flushTimer) clearTimeout(flushTimer);
      await Promise.all([sourceWatcher.close(), reflogWatcher.close()]);
      await flushing;
    },
  };
}
