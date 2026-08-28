import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

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

async function buildMember(memberDir) {
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
  console.log(`built ${path.relative(rootDir, memberDir)}`);
}

const members = await findWorkspaceMembers();
await Promise.all(members.map(buildMember));
