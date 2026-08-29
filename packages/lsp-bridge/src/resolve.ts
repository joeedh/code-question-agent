import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const MIN_MAJOR_VERSION = 7;

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
 * Resolves the `tsc --lsp --stdio` binary to spawn for `repoRoot`: `TSC_LSP_PATH` if set (a
 * custom-built binary, or the nightly `tsgo` channel), else an npm/pnpm-installed `typescript`
 * (7+) found in the repo's own `node_modules`. Throws if neither is available.
 */
export function resolveTscPath(repoRoot: string): string {
  const override = process.env.TSC_LSP_PATH;
  if (override) return override;

  const installed = findInstalledTsc(repoRoot);
  if (installed) return installed;

  throw new Error(
    "no tsc --lsp binary found: install `typescript` (^7.0, which ships --lsp support) in " +
      "this repo, or set TSC_LSP_PATH to a tsc binary built with --lsp support.",
  );
}
