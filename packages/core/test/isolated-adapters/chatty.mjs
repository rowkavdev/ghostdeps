/** Fixture adapter that writes to stdout and stderr during detection. */
// Written at module evaluation, before the worker posts `loaded`: this
// deterministically exercises the host's pre-load output buffering (the
// line must still be labeled with the ecosystem, not the module URL).
process.stdout.write("chatty module load line\n");
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
