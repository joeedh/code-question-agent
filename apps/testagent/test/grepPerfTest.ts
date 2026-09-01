// not an automated unit test, perf profiling tool

const workspaceDir = process.argv[2];
const pattern = process.argv[3] ?? "bleh";
const runs = parseInt(process.argv[4] ?? "5");

import { loadConfig } from "../src/config.ts";
import { grepTool, loadGrepConfig } from "../src/tools/grep.ts";

if (!workspaceDir) throw new Error("path is required");
if (isNaN(runs)) {
  console.log("invalid run count");
}

//load config
const invocationCwd = process.cwd();
const config = await loadConfig(workspaceDir, invocationCwd);
loadGrepConfig(config);

//run
for (let i = 0; i < runs; i++) {
  const time = performance.now();
  console.log(workspaceDir, "pattern:", pattern);
  const result = await grepTool.run(
    { pattern },
    { visionCapable: false, workspaceDir: workspaceDir },
  );
  console.log("got", result.length, "bytes back");
  console.log(`${i + 1} of ${runs}: `, (performance.now() - time).toFixed(2) + "ms");
}
