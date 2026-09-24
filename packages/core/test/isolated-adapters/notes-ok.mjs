/** #205 fixture: detects and lists left-pad; notes() returns one run-level and one capability note. */
const project = { path: ".", ecosystem: "notes-ok", packageManagers: [] };

export default {
  ecosystem: "notes-ok",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    return { confidence: 1, projects: [project], evidence: [] };
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
  async notes() {
    return [
      { statement: "graph edges unavailable" },
      { statement: "credited by config", dependency: "left-pad" },
    ];
  },
};
