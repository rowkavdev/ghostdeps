/**
 * @ghostdeps/core — shared types, dependency model, adapter interface,
 * analysis engine and reporting for GhostDeps.
 */
export * from "./types/index.js";
export * from "./adapter.js";
export * from "./native-rules/index.js";
export { runAdapterContractTests } from "./contract-tests/index.js";
