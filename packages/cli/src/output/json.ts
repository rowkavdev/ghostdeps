import { renderJsonReport, type AnalysisResult } from "@ghostdeps/core";

/**
 * JSON output goes through core's stable reporter (canonical ordering,
 * schema check, escaping) so there is exactly one JSON writer in the project.
 */
export function printJson(result: AnalysisResult, io: { stdout(message: string): void }): void {
  io.stdout(renderJsonReport(result).trimEnd());
}

/**
 * Error shape for --json invocations that fail. Deliberately NOT an
 * AnalysisResult: an empty result would look like a clean scan to scripts
 * (conservative by design applies to false all-clears too).
 */
export function errorJson(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } }, null, 2);
}
