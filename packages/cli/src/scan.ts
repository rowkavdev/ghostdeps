import {
  analyseDirectory,
  type AnalysisResult,
  type EcosystemAdapter,
  type Finding,
} from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import type { CliConfig } from "./config.js";
import type { Io } from "./cli.js";
import { EXIT_OK, NotImplementedError } from "./errors.js";
import { printJson } from "./output/json.js";

/** Adapters the CLI ships with. More ecosystems join as their adapters land. */
export function defaultAdapters(): EcosystemAdapter[] {
  return [createJavaScriptTypeScriptAdapter()];
}

/**
 * Analyse a local directory. Static and offline: core's analyseDirectory reads
 * files through an inert handle, nothing in the repository runs, and skipped
 * files come back as scan-incompleteness findings.
 */
export async function analysePath(path: string): Promise<AnalysisResult> {
  const result = await analyseDirectory(path, {
    adapters: defaultAdapters(),
    network: { mode: "offline" },
  });
  // No recommendation policy exists yet, so the engine emits facts only.
  // Say so in the result: an empty findings list would read as an all-clear.
  return { ...result, findings: [...result.findings, noRecommendationsFinding] };
}

/**
 * Present on every scan until core ships a recommendation policy (#56 and
 * friends). Remove it, and pass the policy to the engine, then.
 */
export const noRecommendationsFinding: Finding = {
  kind: "info",
  summary:
    "No dependency recommendations were made: the recommendation policy is not implemented yet.",
  recommendation:
    "Treat this result as facts only (detected ecosystems, dependencies, usages). It is not an all-clear.",
  evidence: [
    {
      kind: "recommendation-policy-missing",
      statement: "this build of ghostdeps runs without a recommendation policy",
    },
  ],
  confidence: "high",
  limitations: ["Unused, unnecessary and native-replacement findings are not produced yet."],
  affectedFiles: [],
};

/** `ghostdeps scan [path]`. --json prints the schema-stable AnalysisResult. */
export async function runScan(config: CliConfig, io: Io): Promise<number> {
  if (!config.json) {
    // Human output lands with the repository-summary renderer (#39/#109).
    throw new NotImplementedError("ghostdeps scan is not implemented yet");
  }
  printJson(await analysePath(config.path), io);
  return EXIT_OK;
}
