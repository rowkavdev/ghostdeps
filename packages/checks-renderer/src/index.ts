/**
 * The Check Run rendering contract: AnalysisResult -> check conclusion,
 * summary and annotations. Shared by @ghostdeps/github-app and
 * @ghostdeps/action so both distribution channels render identically (#318).
 * Extracted verbatim from packages/github-app/src/checks (render.ts, diff.ts).
 */
export {
  busyCheck,
  checkName,
  failedCheck,
  incompleteTitle,
  maxAnnotations,
  md,
  plain,
  quietSummary,
  renderCheck,
  truncateSummary,
} from "./render.js";
export type { CheckAnnotation, CheckOutput } from "./render.js";
export { addedLinesFromFiles, addedLinesFromPatch } from "./diff.js";
export type { AddedLines } from "./diff.js";
