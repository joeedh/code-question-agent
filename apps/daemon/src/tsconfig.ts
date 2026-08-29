import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import picomatch from "picomatch";

interface TsconfigJson {
  include?: string[];
  exclude?: string[];
  files?: string[];
}

export interface ProjectFileFilter {
  isProjectFile: (absolutePath: string) => boolean;
}

const alwaysProjectFile: ProjectFileFilter = { isProjectFile: () => true };

/**
 * TypeScript treats a bare directory (no wildcard) in `include`/`exclude` as covering
 * everything beneath it. Approximated here rather than matched exactly — this doesn't
 * replicate TS's implicit extension matching for such an entry.
 */
function toGlob(pattern: string): string {
  return /[*?]/.test(pattern) ? pattern : `${pattern.replace(/\/+$/, "")}/**/*`;
}

/**
 * Narrows cold-start/watcher file discovery to what a repo's root `tsconfig.json` considers
 * project source, when it has one. Deliberately lightweight: reads only the root
 * `tsconfig.json` (no `extends` merging, no project-reference traversal — this tool already
 * assumes one repo maps to one `LspBridge` rootDir) and matches `include`/`exclude`/`files`
 * with `picomatch` rather than replicating every TypeScript-specific default (`outDir`
 * exclusion, implicit per-extension matching, etc.). A repo with no `tsconfig.json`, or one
 * `jsonc-parser` can't parse, keeps indexing everything `listTrackedFiles` reports.
 */
export function loadProjectFileFilter(repoRoot: string): ProjectFileFilter {
  const configPath = path.join(repoRoot, "tsconfig.json");
  if (!existsSync(configPath)) return alwaysProjectFile;

  let config: TsconfigJson;
  try {
    config = parseJsonc(readFileSync(configPath, "utf8")) as TsconfigJson;
  } catch {
    return alwaysProjectFile;
  }
  if (!config || typeof config !== "object") return alwaysProjectFile;

  const includePatterns = [...(config.include ?? []).map(toGlob), ...(config.files ?? [])];
  const excludePatterns = ["**/node_modules/**", ...(config.exclude ?? []).map(toGlob)];

  const isIncluded = includePatterns.length > 0 ? picomatch(includePatterns) : () => true;
  const isExcluded = picomatch(excludePatterns);

  return {
    isProjectFile: (absolutePath: string) => {
      const relative = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      return isIncluded(relative) && !isExcluded(relative);
    },
  };
}
