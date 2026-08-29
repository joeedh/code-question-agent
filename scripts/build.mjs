import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as esbuild from "esbuild";

const execFileAsync = promisify(execFile);

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function findWorkspaceMembers() {
  const members = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const name of await readdir(groupDir)) {
      const memberDir = path.join(groupDir, name);
      if (existsSync(path.join(memberDir, "package.json"))) {
        members.push(memberDir);
      }
    }
  }
  return members;
}

async function bundleMember(memberDir) {
  const entry = path.join(memberDir, "src", "index.ts");
  if (!existsSync(entry)) return;
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(memberDir, "dist", "index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    sourcemap: true,
  });
}

// Other workspace packages import a member by its declared "types" entry point
// (`./dist/index.d.ts`), so it needs real declarations, not just the bundled runtime
// esbuild produces. A member that imports another workspace member's types can only
// declare-build once that dependency's own `dist/index.d.ts` exists, so this retries
// failures across passes rather than hand-maintaining a dependency order.
async function declareMember(memberDir) {
  const entry = path.join(memberDir, "src", "index.ts");
  if (!existsSync(entry)) return;
  // Apps aren't imported by other workspace members, so they don't declare a "types"
  // entry point and don't need a declaration build.
  const manifest = JSON.parse(await readFile(path.join(memberDir, "package.json"), "utf8"));
  if (!manifest.types) return;
  await execFileAsync(
    "tsc",
    ["-p", path.join(memberDir, "tsconfig.declare.json")],
    // node_modules/.bin ships `tsc.cmd` on Windows, which a shell-less spawn can't resolve.
    { shell: true },
  );
}

const members = await findWorkspaceMembers();
await Promise.all(members.map(bundleMember));

let remaining = members;
let lastError;
for (let pass = 0; pass < members.length && remaining.length > 0; pass++) {
  const outcomes = await Promise.allSettled(remaining.map(declareMember));
  const stillFailing = [];
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "rejected") {
      stillFailing.push(remaining[i]);
      lastError = outcome.reason;
    }
  });
  remaining = stillFailing;
}
if (remaining.length > 0) throw lastError;

for (const memberDir of members) {
  if (existsSync(path.join(memberDir, "src", "index.ts"))) {
    console.log(`built ${path.relative(rootDir, memberDir)}`);
  }
}
