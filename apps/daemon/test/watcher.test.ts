import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTrackedFiles, watchRepo } from "../src/watcher.ts";

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoDir });
  return stdout.trim();
}

async function initRepo(repoDir: string): Promise<void> {
  await git(repoDir, ["init", "--quiet"]);
  await git(repoDir, ["config", "user.email", "test@example.com"]);
  await git(repoDir, ["config", "user.name", "Test"]);
}

async function commit(repoDir: string, message: string): Promise<void> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "--quiet", "-m", message]);
}

function waitUntil(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

describe("listTrackedFiles", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-watcher-list-"));
    await initRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("includes tracked and untracked files, excludes gitignored ones", async () => {
    await writeFile(path.join(repoDir, "tracked.ts"), "export const a = 1;\n");
    await commit(repoDir, "add tracked");
    await writeFile(path.join(repoDir, "untracked.ts"), "export const b = 2;\n");
    await writeFile(path.join(repoDir, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(repoDir, "ignored.ts"), "export const c = 3;\n");

    const files = (await listTrackedFiles(repoDir)).map((f) => path.basename(f)).sort();
    expect(files).toContain("tracked.ts");
    expect(files).toContain("untracked.ts");
    expect(files).not.toContain("ignored.ts");
  });
});

describe("watchRepo", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "code-question-agent-watcher-"));
    await initRepo(repoDir);
    await writeFile(path.join(repoDir, ".gitignore"), "ignored.ts\n");
    await commit(repoDir, "initial");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("reports tracked and untracked file changes, filters gitignored ones", async () => {
    const changed: string[] = [];
    const watcher = watchRepo(
      repoDir,
      {
        onFileChanged: (file) => changed.push(path.basename(file)),
        onFileRemoved: () => undefined,
        onReflogChanged: () => undefined,
      },
      20,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // let chokidar's initial scan settle
      await writeFile(path.join(repoDir, "seen.ts"), "export const a = 1;\n");
      await writeFile(path.join(repoDir, "ignored.ts"), "export const b = 2;\n");

      await waitUntil(() => changed.includes("seen.ts"), 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changed).not.toContain("ignored.ts");
    } finally {
      await watcher.close();
    }
  }, 15_000);

  it("coalesces a burst of writes into one batch instead of one git spawn per file", async () => {
    const batches: string[][] = [];
    let current: string[] | undefined;
    const watcher = watchRepo(
      repoDir,
      {
        // `flush` dispatches a whole batch synchronously, so paths landing in one turn of the
        // event loop came from a single `git check-ignore`.
        onFileChanged: (file) => {
          if (!current) {
            current = [];
            batches.push(current);
            setImmediate(() => (current = undefined));
          }
          current.push(path.basename(file));
        },
        onFileRemoved: () => undefined,
        onReflogChanged: () => undefined,
      },
      20,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const names = Array.from({ length: 200 }, (_, i) => `burst-${i}.ts`);
      await Promise.all(
        names.map((name) => writeFile(path.join(repoDir, name), "export const a = 1;\n")),
      );

      const seen = (): string[] => batches.flat();
      await waitUntil(() => names.every((name) => seen().includes(name)), 10_000);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Pre-fix this was one batch (and one spawned process) per file.
      expect(batches.length).toBeLessThan(20);
    } finally {
      await watcher.close();
    }
  }, 30_000);

  it("raises no events for node_modules churn", async () => {
    const changed: string[] = [];
    const watcher = watchRepo(
      repoDir,
      {
        onFileChanged: (file) => changed.push(file),
        onFileRemoved: () => undefined,
        onReflogChanged: () => undefined,
      },
      20,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await mkdir(path.join(repoDir, "node_modules", "pkg"), { recursive: true });
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          writeFile(
            path.join(repoDir, "node_modules", "pkg", `dep-${i}.ts`),
            "export const a = 1;\n",
          ),
        ),
      );
      await writeFile(path.join(repoDir, "sentinel.ts"), "export const a = 1;\n");

      await waitUntil(() => changed.some((file) => path.basename(file) === "sentinel.ts"), 5_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changed.filter((file) => file.includes("node_modules"))).toEqual([]);
    } finally {
      await watcher.close();
    }
  }, 30_000);

  it("fires a debounced reflog-change signal on commit", async () => {
    let fired = 0;
    const watcher = watchRepo(
      repoDir,
      {
        onFileChanged: () => undefined,
        onFileRemoved: () => undefined,
        onReflogChanged: () => {
          fired += 1;
        },
      },
      20,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(path.join(repoDir, "for-commit.ts"), "export const a = 1;\n");
      await commit(repoDir, "second");

      await waitUntil(() => fired > 0, 5_000);
      expect(fired).toBeGreaterThan(0);
    } finally {
      await watcher.close();
    }
  }, 15_000);
});
