/** #205 fixture: detects and lists left-pad; notes() spins synchronously, so only the watchdog can stop it. */
const project = { path: ".", ecosystem: "notes-busy", packageManagers: [] };

export default {
  ecosystem: "notes-busy",
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
    // Spin synchronously; only the watchdog can stop this.
    for (;;) {
      Math.random();
    }
  },
};
