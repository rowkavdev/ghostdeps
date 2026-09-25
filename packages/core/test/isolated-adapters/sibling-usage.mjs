/** An independent adapter whose positive facts survive its sibling's timeout. */
const project = { path: ".", ecosystem: "sibling-rust", packageManagers: [] };
export default {
  ecosystem: "sibling-rust",
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
        name: "rust-dep",
        constraint: "^1.0.0",
        kind: "runtime",
        project,
        declaredIn: "package.json",
      },
    ];
  },
  async findUsage() {
    return [
      {
        dependency: "rust-dep",
        file: "crates/next-swc/src/lib.rs",
        line: 1,
        form: "static",
        symbols: [],
      },
    ];
  },
};
