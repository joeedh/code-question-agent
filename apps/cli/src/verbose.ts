import { type CliOptions } from "./args.ts";

export interface VerboseLogger {
  isEnabled(tag: string): boolean;
  log(tag: string, message: string): void;
}

/** No-op unless `-v`/`--verbose` was given; a bare `-v` (`verboseTags` left `undefined`) enables every tag. */
export function createVerboseLogger(opts: CliOptions): VerboseLogger {
  function isEnabled(tag: string): boolean {
    if (!opts.verbose) return false;
    return opts.verboseTags === undefined || opts.verboseTags.includes(tag);
  }

  return {
    isEnabled,
    log(tag, message) {
      if (isEnabled(tag)) console.error(`[${tag}] ${message}`);
    },
  };
}
