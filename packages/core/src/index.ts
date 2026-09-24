/**
 * @ghostdeps/core — shared types, dependency model, adapter interface,
 * analysis engine and reporting for GhostDeps.
 */
export * from "./types/index.js";
export * from "./limits.js";
export * from "./adapter.js";
export * from "./checkout/index.js";
export * from "./native-rules/index.js";
export * from "./report/index.js";
export * from "./diff/index.js";
export { runAdapterContractTests } from "./contract-tests/index.js";
export {
  policyContractFixtures,
  runRecommendationPolicyContractTests,
} from "./contract-tests/policy.js";
export * from "./engine/scanner/index.js";
export * from "./engine/index.js";
