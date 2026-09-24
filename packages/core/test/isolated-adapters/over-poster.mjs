/** Fixture adapter that posts more dependencies than the main-side cap keeps. */
const project = { path: ".", ecosystem: "over-poster", packageManagers: [] };

export default {
  ecosystem: "over-poster",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    return { confidence: 1, projects: [project], evidence: [] };
  },
  async listDirectDependencies() {
    const dependencies = [];
    for (let i = 0; i < 12_000; i++) {
      dependencies.push({
        name: `dep-${i}`,
        constraint: "^1.0.0",
        kind: "runtime",
        project,
        declaredIn: "package.json",
      });
    }
    return dependencies;
  },
};
