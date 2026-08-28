// TypeScript 7 drops the classic compiler API typescript-eslint needs, so it
// hard-refuses to load against it. Pin these packages to a private
// typescript@6 copy, decoupled from the workspace's real typescript@7.
const TS6_PINNED_PACKAGES = new Set([
  "typescript-eslint",
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
]);

function readPackage(pkg) {
  if (TS6_PINNED_PACKAGES.has(pkg.name)) {
    pkg.dependencies = { ...pkg.dependencies, typescript: "6.0.3" };
    if (pkg.peerDependencies) delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
  }
  return pkg;
}

module.exports = {
  hooks: { readPackage },
};
