import {
  analyseDirectory,
  type AnalysisResult,
  type EcosystemAdapter,
  type Finding,
} from "@ghostdeps/core";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import { stat } from "node:fs/promises";
import type { CliConfig } from "./config.js";
import type { Io } from "./cli.js";
import { EXIT_OK } from "./errors.js";
import { renderRepositorySummary } from "./output/human.js";
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
  await assertDirectory(config.path);
  const result = await analysePath(config.path);
  if (config.json) {
    printJson(result, io);
  } else {
    io.stdout(renderRepositorySummary(result));
  }
  return EXIT_OK;
}

/** Fail with one clear line on a missing path or a file, not an ENOENT dump. */
async function assertDirectory(path: string): Promise<void> {
  const st = await stat(path).catch(() => undefined);
  if (st === undefined || !st.isDirectory()) {
    throw new Error(`path is not a directory: ${path}`);
  }
}
