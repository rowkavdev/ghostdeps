/** #205 fixture: detects and lists left-pad; notes() never settles (async hang). */
const project = { path: ".", ecosystem: "notes-hang", packageManagers: [] };

export default {
  ecosystem: "notes-hang",
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
    return new Promise(() => {});
  },
};
