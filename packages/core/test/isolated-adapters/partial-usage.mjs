/** First usage settles; second hangs (or stalls) to exercise partial salvage. */
const project = { path: ".", ecosystem: "partial-fixture", packageManagers: [] };
export default {
  ecosystem: "partial-fixture",
  apiVersion: "0.1.0",
  capabilities: new Set(["usageAnalysis", "referenceAnalysis"]),
  async detect() {
    return {
      confidence: 1,
      projects: [project],
      evidence: [{ kind: "manifest", statement: "test" }],
    };
  },
  async listDirectDependencies() {
    return ["used", "unknown"].map((name) => ({
      name,
      constraint: "^1.0.0",
      kind: "runtime",
      project,
      declaredIn: "package.json",
    }));
  },
  async findUsage(_context, dep) {
    if (dep.name === "unknown") await new Promise(() => {});
    return [{ dependency: dep.name, file: "src/index.js", line: 1, form: "static", symbols: [] }];
  },
};
