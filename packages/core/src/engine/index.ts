export {
  analyseRepository,
  detectionConfidence,
  pullRequestCoverageFindings,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DEFAULT_DETECTION_THRESHOLD,
  DEFAULT_USAGE_CONCURRENCY,
  type AnalyseOptions,
  type RecommendationInput,
  type RecommendationPolicy,
  type EngineRuleConfig,
} from "./analyse.js";
export {
  analyseRepositoryIsolated,
  runAdapterIsolated,
  capOutcome,
  DEFAULT_ADAPTER_HEAP_MB,
  DEFAULT_MAX_PARALLEL_ADAPTERS,
  OUTCOME_CAPS,
  type IsolatedAnalyseOptions,
} from "./isolated.js";
export { buildProjectTree, projectId } from "./project-tree.js";
export { buildUnifiedGraph } from "./unified-graph.js";
export {
  analyseDirectory,
  scanCompletenessFindings,
  type AnalyseDirectoryOptions,
} from "./analyse-directory.js";
export { crossEcosystemOverlaps, CROSS_ECOSYSTEM_OVERLAP_RULE } from "./capability-overlap.js";
export {
  sameEcosystemDuplicates,
  SAME_ECOSYSTEM_DUPLICATES_RULE,
} from "./capability-duplicates.js";
export { addFootprints, FOOTPRINT_TIMEOUT_MS, MAX_FOOTPRINT_PACKAGES } from "./footprint.js";
export { previewNpmRemoval, type FixPreview } from "./fix-preview.js";
