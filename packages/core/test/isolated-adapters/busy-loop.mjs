/** Hostile fixture adapter: synchronous busy loop in detection. Only a
 * preemptive tier can stop it - in-process this hangs the whole run. */
export default {
  ecosystem: "busy-loop",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    for (;;) {
      /* synchronous CPU burn */
    }
  },
  async listDirectDependencies() {
    return [];
  },
};
