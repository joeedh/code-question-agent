import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_MAJOR_VERSION = 7;
const SELF_PACKAGE_NAME = "code-question-agent";

function majorVersion(version: string | undefined): number {
  return Number.parseInt(version?.split(".")[0] ?? "", 10);
}

/**
 * Walks `startDir` and its ancestors for `node_modules/<packageName>/package.json`, the same
 * directory-by-directory search Node's own module resolution does. Done by hand rather than via
 * `require.resolve` because `require.resolve` also consults `NODE_PATH` as a final fallback —
 * global to the machine, unrelated to `startDir` — which can silently resolve to some other
 * project's install instead of reporting that `startDir` has none of its own.
 */
function findPackageJson(startDir: string, packageName: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", packageName, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves an npm/pnpm-installed `typescript` package's `tsc` entry point, starting the
 * `node_modules` search from `repoRoot` and walking up — so a pnpm-hoisted or monorepo-root
 * install resolves too. Returns `undefined` if nothing installed satisfies
 * `MIN_MAJOR_VERSION` (TypeScript 7, the "Corsa" rewrite, is the first release whose `tsc`
 * understands `--lsp --stdio`; anything older doesn't).
 */
export function findInstalledTsc(repoRoot: string): string | undefined {
  const pkgJsonPath = findPackageJson(repoRoot, "typescript");
  if (!pkgJsonPath) return undefined;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    version?: string;
    bin?: Record<string, string> | string;
  };
  if (majorVersion(pkg.version) < MIN_MAJOR_VERSION) return undefined;

  const binField = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsc;
  if (!binField) return undefined;

  return path.resolve(path.dirname(pkgJsonPath), binField);
}

/**
 * If this file's own location, walked upward, reaches a `package.json` named
 * `SELF_PACKAGE_NAME` — i.e. this is running from a source checkout of the
 * code-question-agent monorepo, not installed as a dependency inside some other project —
 * returns that checkout's root. Otherwise `undefined`.
 */
function findSelfCheckoutRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
      if (pkg.name === SELF_PACKAGE_NAME) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the `tsc --lsp --stdio` binary to spawn for `repoRoot`, trying in order:
 * `TSC_LSP_PATH` (a custom-built binary, or the nightly `tsgo` channel), an npm/pnpm-installed
 * `typescript` (7+) in `repoRoot`'s own `node_modules`, or — only when this is itself a source
 * checkout of code-question-agent (`findSelfCheckoutRoot`) — that checkout's own installed
 * `typescript`. The last tier means a target repo with no `typescript` of its own doesn't need
 * one installed just to be usable during development of this tool; it's skipped entirely for a
 * real install (inside some other project's `node_modules`), where it would just be the
 * previous tier again under another name. Throws if nothing above is available.
 */
export function resolveTscPath(repoRoot: string): string {
  const override = process.env.TSC_LSP_PATH;
  if (override) return override;

  const installed = findInstalledTsc(repoRoot);
  if (installed) return installed;

  const selfRoot = findSelfCheckoutRoot();
  const selfInstalled = selfRoot && findInstalledTsc(selfRoot);
  if (selfInstalled) return selfInstalled;

  throw new Error(
    "no tsc --lsp binary found: install `typescript` (^7.0, which ships --lsp support) in " +
      "this repo, or set TSC_LSP_PATH to a tsc binary built with --lsp support.",
  );
}
