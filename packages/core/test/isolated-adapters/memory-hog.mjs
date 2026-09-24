/** Hostile fixture adapter: allocates until the worker heap ceiling kills it. */
export default {
  ecosystem: "memory-hog",
  capabilities: new Set(),
  apiVersion: "0.1.0",
  async detect() {
    const chunks = [];
    for (;;) {
      chunks.push(new Array(1_000_000).fill("x"));
    }
  },
  async listDirectDependencies() {
    return [];
  },
};
