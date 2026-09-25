/** Fixture adapter that floods stdout at module evaluation (before `loaded`). */
for (let i = 0; i < 150; i += 1) process.stdout.write(`flood line ${i}\n`);
const project = { path: ".", ecosystem: "floody", packageManagers: [] };

export default {
  ecosystem: "floody",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    return { confidence: 1, projects: [project], evidence: [] };
  },
  async listDirectDependencies() {
    return [];
  },
};
