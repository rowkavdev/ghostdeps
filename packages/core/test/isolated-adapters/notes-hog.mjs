/** #205 fixture: detects and lists left-pad; notes() grows the heap until the worker dies. */
const project = { path: ".", ecosystem: "notes-hog", packageManagers: [] };

export default {
  ecosystem: "notes-hog",
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
    const chunks = [];
    for (;;) chunks.push(new Array(1_000_000).fill("x"));
  },
};
