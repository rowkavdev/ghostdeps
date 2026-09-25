/** No findUsage call settles before the stage timeout. */
const project = { path: ".", ecosystem: "timed-out-js", packageManagers: [] };
export default {
  ecosystem: "timed-out-js",
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
    return [
      {
        name: "js-dep",
        constraint: "^1.0.0",
        kind: "runtime",
        project,
        declaredIn: "package.json",
      },
    ];
  },
  async findUsage() {
    await new Promise(() => {});
  },
};
