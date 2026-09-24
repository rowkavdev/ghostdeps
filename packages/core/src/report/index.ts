export { jsonSchemaVersion, normaliseAnalysisResult, renderJsonReport } from "./json.js";
export {
  UNUSED_CONFIDENCE_CAP,
  UNUSED_SEVERITY_CAP,
  capConfidence,
  atOrAboveSeverity,
  effectiveSeverity,
  parseSeverity,
  severityOf,
  severityOrder,
} from "./severity.js";
export type { Severity } from "./severity.js";
