/**
 * @ghostdeps/javascript-typescript — ecosystem adapter for JavaScript and
 * TypeScript projects (npm, pnpm, Yarn, Bun). ADR 0002 is the contract.
 */
export { createJavaScriptTypeScriptAdapter } from "./adapter.js";
export {
  DETECTION_CONFIDENCE_THRESHOLD,
  JS_ECOSYSTEM,
  detectJavaScriptTypeScript,
} from "./detect.js";
export { detectPackageManagers } from "./package-managers.js";
export type { PackageManagerDetection } from "./package-managers.js";
export { classifySpecifier, parseManifest, parseManifestText } from "./manifest.js";
export type { ManifestParseResult } from "./manifest.js";
export {
  findMatchedApiReferences,
  MAX_MATCHED_REFERENCES,
  MAX_RESOLUTION_DEPTH,
} from "./native/matched-apis.js";
export type {
  MatchedApiHop,
  MatchedApiOptions,
  MatchedApiReference,
  MatchedApiResolution,
  MatchedApiScan,
  MatchedApiSpan,
} from "./native/matched-apis.js";
export {
  inspectIncompatiblePatterns,
  MAX_PATTERN_BYTES,
  MAX_PATTERN_FILES,
  MAX_PATTERN_OBSERVATIONS,
} from "./native/pattern-inspections.js";
export type { PatternInspection, PatternKind } from "./native/pattern-inspections.js";

export { inspectSemanticFlows, MAX_SEMANTIC_NODES } from "./native/semantic-inspections.js";
export type {
  SemanticFlowInspection,
  SemanticFlowKind,
  SemanticFlowState,
} from "./native/semantic-inspections.js";
