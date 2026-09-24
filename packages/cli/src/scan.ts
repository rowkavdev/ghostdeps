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
import { atOrAboveSeverity } from "@ghostdeps/core";
import { EXIT_OK, EXIT_THRESHOLD } from "./errors.js";
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

/**
 * `ghostdeps scan [path]`. --json prints the complete schema-stable
 * AnalysisResult - never filtered, so the completeness and no-policy info
 * findings can't be hidden into a false all-clear. --severity filters the
 * human display only. --fail-on exits 1 when any finding (shown or not)
 * reaches the threshold, so CI can gate on it. Without --fail-on a successful
 * scan always exits 0: GhostDeps advises, it does not gate.
 */
export async function runScan(config: CliConfig, io: Io): Promise<number> {
  await assertDirectory(config.path);
  const result = await analysePath(config.path);
  const min = config.severity;
  const shown =
    min === undefined
      ? result
      : { ...result, findings: result.findings.filter((f) => atOrAboveSeverity(f, min)) };
  if (config.json) {
    printJson(shown, io);
  } else {
    io.stdout(renderRepositorySummary(shown));
    const hidden = result.findings.length - shown.findings.length;
    if (hidden > 0) {
      // Filtering must never read as a clean "Findings: none" all-clear.
      io.stdout(
        `(${hidden} finding${hidden === 1 ? "" : "s"} below the --severity ${min} filter hidden)`,
      );
    }
  }
  const failOn = config.failOn;
  if (failOn !== undefined && result.findings.some((f) => atOrAboveSeverity(f, failOn))) {
    return EXIT_THRESHOLD;
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
