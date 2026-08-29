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
  const output = await git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
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
  return pairs.filter(([, relative]) => !ignored.has(relative)).map(([absolutePath]) => absolutePath);
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
 * Watches the tracked source tree (via `chokidar`, `.git` excluded) and, separately, the
 * reflog (`.git/logs/HEAD`) — appended to on every ref update (commit, checkout, merge,
 * rebase) — as the checkpoint-capture trigger, avoiding a git hook this tool doesn't own.
 */
export function watchRepo(repoRoot: string, handlers: WatcherHandlers, debounceMs = 150): RepoWatcher {
  const debounce = debouncer(debounceMs);
  const reflogPath = path.join(repoRoot, ".git", "logs", "HEAD");

  const sourceWatcher = chokidar.watch(repoRoot, {
    ignored: /(^|[/\\])\.git([/\\]|$)/,
    ignoreInitial: true,
    persistent: true,
  });

  sourceWatcher.on("add", (filePath: string) => {
    void filterIgnored(repoRoot, [filePath]).then(([kept]) => {
      if (kept) debounce(filePath, () => handlers.onFileChanged(filePath));
    });
  });
  sourceWatcher.on("change", (filePath: string) => {
    void filterIgnored(repoRoot, [filePath]).then(([kept]) => {
      if (kept) debounce(filePath, () => handlers.onFileChanged(filePath));
    });
  });
  sourceWatcher.on("unlink", (filePath: string) => {
    debounce(filePath, () => handlers.onFileRemoved(filePath));
  });

  const reflogWatcher = chokidar.watch(reflogPath, { ignoreInitial: true, persistent: true });
  reflogWatcher.on("add", () => debounce(reflogPath, handlers.onReflogChanged));
  reflogWatcher.on("change", () => debounce(reflogPath, handlers.onReflogChanged));

  return {
    close: async () => {
      await Promise.all([sourceWatcher.close(), reflogWatcher.close()]);
    },
  };
}
