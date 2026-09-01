import { readFile } from "node:fs/promises";
import path from "node:path";
import { isOpenRouterModel } from "./provider.ts";
import { isCode, stripComments } from "./utils.ts";

export const TOOL_NAMES = ["cli", "grep", "read", "ls", "cdp", "bash", "image"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools whose result carries an `image` block, so a text-only model cannot be offered them. */
export const VISION_TOOLS: readonly ToolName[] = ["image"];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export let theConfig: TestAgentConfig = {
  enabledTools: [],
  toolLimits: {},
  maxTokenBudget: 0,
  stripAllDocs: {},
};

export interface TestAgentConfig {
  enabledTools: ToolName[];
  toolLimits: Partial<Record<ToolName, number>>;
  maxTokenBudget: number;
  model?: string;
  effort?: Effort;
  /** Overrides the guess `modelSupportsVision` makes about whether `model` reads images. */
  visionCapable?: boolean;
  grepExclude?: string[];
  // hide all comments and non-code files from
  // the model
  stripAllDocs: {
    markdown?: boolean;
    comments?: boolean;
  };
}

const CONFIG_FILE_NAME = ".testagent-config.json";

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

function isEffort(value: string): value is Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Validates a parsed `.testagent-config.json` payload, throwing a descriptive error on any violation. */
export function validateConfig(raw: unknown, configPath: string): TestAgentConfig {
  const fail = (message: string): never => {
    throw new Error(`${configPath}: ${message}`);
  };

  if (typeof raw !== "object" || raw === null) fail("expected a JSON object");
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.enabledTools)) fail('"enabledTools" must be an array');
  const enabledTools: ToolName[] = [];
  for (const entry of obj.enabledTools as unknown[]) {
    if (typeof entry !== "string" || !isToolName(entry)) {
      fail(`"enabledTools" contains an unknown tool name ${JSON.stringify(entry)}`);
    }
    enabledTools.push(entry as ToolName);
  }

  if (typeof obj.toolLimits !== "object" || obj.toolLimits === null) {
    fail('"toolLimits" must be an object');
  }
  const rawLimits = obj.toolLimits as Record<string, unknown>;
  const toolLimits: Partial<Record<ToolName, number>> = {};
  for (const tool of enabledTools) {
    const limit = rawLimits[tool];
    if (limit === undefined) {
      fail(`"toolLimits" is missing an entry for enabled tool ${JSON.stringify(tool)}`);
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < -1) {
      fail(
        `"toolLimits.${tool}" must be an integer >= -1 (-1 means unlimited), got ${JSON.stringify(limit)}`,
      );
    }
    toolLimits[tool] = limit as number;
  }

  const maxTokenBudget = obj.maxTokenBudget;
  if (
    typeof maxTokenBudget !== "number" ||
    !Number.isInteger(maxTokenBudget) ||
    (maxTokenBudget !== -1 && maxTokenBudget < 1)
  ) {
    fail(
      `"maxTokenBudget" must be -1 (unlimited) or an integer >= 1, got ${JSON.stringify(maxTokenBudget)}`,
    );
  }

  let model: string | undefined;
  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.length === 0)
      fail('"model" must be a non-empty string');
    model = obj.model as string;
  }

  let effort: Effort | undefined;
  if (obj.effort !== undefined) {
    if (typeof obj.effort !== "string" || !isEffort(obj.effort)) {
      fail(
        `"effort" must be one of ${EFFORT_LEVELS.join(", ")}, got ${JSON.stringify(obj.effort)}`,
      );
    }
    effort = obj.effort as Effort;
  }

  let visionCapable: boolean | undefined;
  if (obj.visionCapable !== undefined) {
    if (typeof obj.visionCapable !== "boolean") fail('"visionCapable" must be a boolean');
    visionCapable = obj.visionCapable as boolean;
  }

  const grepExclude = [] as string[];
  for (const s of (obj.grepExclude as any) ?? []) {
    if (typeof s !== "string") {
      fail(`"grepExclude" must be an array of strings, got ${JSON.stringify(s)}`);
    }
    grepExclude.push(s);
  }

  let stripAllDocs: typeof theConfig.stripAllDocs | undefined;

  if (
    obj.stripAllDocs !== undefined &&
    (typeof obj.stripAllDocs !== "object" || Array.isArray(obj.stripAllDocs))
  ) {
    fail('"stripAllDocs" must be an object');
  } else {
    stripAllDocs = obj.stripAllDocs ?? {};
    for (const key in stripAllDocs) {
      if (key !== "markdown" && key !== "comments") {
        fail(`"stripAllDocs" must contain only .markdown and .comments`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (stripAllDocs as any)[key] !== "boolean") {
        fail(`"stripAllDocs.${key}" must be a boolean`);
      }
    }
  }

  Object.assign(theConfig, {
    grepExclude,
    enabledTools,
    toolLimits,
    maxTokenBudget: maxTokenBudget as number,
    model,
    effort,
    visionCapable,
    stripAllDocs,
  });

  return theConfig;
}

/**
 * Loads and validates `.testagent-config.json`, looked up first at `<workspaceDir>/` and,
 * when it's not found there, at `<invocationCwd>/` (the directory `pnpm testagent` was run
 * from) instead.
 */
export async function loadConfig(
  workspaceDir: string,
  invocationCwd: string,
): Promise<TestAgentConfig> {
  const candidates = [path.join(workspaceDir, CONFIG_FILE_NAME)];
  const cwdConfigPath = path.join(invocationCwd, CONFIG_FILE_NAME);
  if (cwdConfigPath !== candidates[0]) candidates.push(cwdConfigPath);

  let raw: string | undefined;
  let configPath = candidates[0]!;
  for (const candidate of candidates) {
    try {
      raw = await readFile(candidate, "utf8");
      configPath = candidate;
      break;
    } catch {
      // Try the next candidate.
    }
  }

  if (raw === undefined) {
    throw new Error(
      `Could not find .testagent-config.json in ${candidates.join(" or ")}. Copy ` +
        `apps/testagent/.testagent-config.json.example to one of those paths and adjust it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${configPath}: not valid JSON`, { cause: error });
  }
  return validateConfig(parsed, configPath);
}

/**
 * Reports whether the configured model can read `image` blocks. `visionCapable` in the config
 * file settles it; otherwise a Claude model (the default when `model` is unset) is taken as
 * capable, and an OpenRouter `<vendor>/<name>` id as not, since sending an image to a
 * text-only model there fails the whole request rather than degrading.
 */
export function modelSupportsVision(config: TestAgentConfig): boolean {
  if (config.visionCapable !== undefined) return config.visionCapable;
  if (config.model === undefined) return true;
  return !isOpenRouterModel(config.model);
}

/**
 * Resolves the effective tool set: `--tools=` is a subset filter over `config.enabledTools`.
 * Errors if `--tools=` names a tool that config either omits or limits to zero calls. A tool
 * from `VISION_TOOLS` is dropped when the model cannot read images, and named explicitly it
 * is an error instead.
 */
export function resolveToolSelection(
  cliToolsFlag: ToolName[] | undefined,
  config: TestAgentConfig,
): ToolName[] {
  const vision = modelSupportsVision(config);
  if (cliToolsFlag === undefined) {
    const dropped = config.enabledTools.filter((tool) => !vision && VISION_TOOLS.includes(tool));
    if (dropped.length > 0) {
      console.warn(
        `warning: disabling ${dropped.join(", ")} because model ${JSON.stringify(config.model)} ` +
          `is not known to read images. Set "visionCapable": true in the config file to keep them.`,
      );
    }
    return config.enabledTools.filter((tool) => !dropped.includes(tool));
  }
  for (const tool of cliToolsFlag) {
    if (!config.enabledTools.includes(tool)) {
      throw new Error(
        `--tools names ${JSON.stringify(tool)}, but it is not in "enabledTools" in the config file`,
      );
    }
    if (!vision && VISION_TOOLS.includes(tool)) {
      throw new Error(
        `--tools names ${JSON.stringify(tool)}, but model ${JSON.stringify(config.model)} is not ` +
          `known to read images. Set "visionCapable": true in the config file to override this.`,
      );
    }
  }
  return cliToolsFlag;
}

export function skipPath(path: string) {
  return theConfig.stripAllDocs.markdown ? !isCode(path) : false;
}

export function filterCode(code: string, path: string) {
  return theConfig.stripAllDocs.comments ? stripComments(code, path) : code;
}
