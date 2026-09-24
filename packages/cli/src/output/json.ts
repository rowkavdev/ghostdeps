import type { AnalysisResult } from "@ghostdeps/core";

/**
 * Schema-shaped empty result. Stub commands emit this under --json so
 * consumers can build against the result contract before the engine lands.
 */
export function emptyAnalysisResult(): AnalysisResult {
  return {
    schemaVersion: 1,
    projects: [],
    dependencies: [],
    usages: [],
    findings: [],
    detected: [],
    surface: [],
  };
}

export function printJson(value: unknown, io: { stdout(message: string): void }): void {
  io.stdout(JSON.stringify(value, null, 2));
}
