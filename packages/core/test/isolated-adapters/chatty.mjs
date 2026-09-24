/** Fixture adapter that writes to stdout and stderr during detection. */
const project = { path: ".", ecosystem: "chatty", packageManagers: [] };

export default {
  ecosystem: "chatty",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    process.stdout.write("chatty detection log line\n");
    process.stderr.write("chatty detection error line\n");
    return { confidence: 1, projects: [project], evidence: [] };
  },
  async listDirectDependencies() {
    return [];
  },
};
