/** Well-behaved fixture adapter: detects, lists one dependency, no optional stages. */
const project = { path: ".", ecosystem: "fixture", packageManagers: [] };

export default {
  ecosystem: "fixture",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    return {
      confidence: 1,
      projects: [project],
      evidence: [{ kind: "manifest", statement: "fixture manifest found", file: "package.json" }],
    };
  },
  async listDirectDependencies() {
    return [
      {
        name: "left-pad",
        constraint: "^1.0.0",
        kind: "runtime",
        project,
        declaredIn: "package.json",
      },
    ];
  },
};
