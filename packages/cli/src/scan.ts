import {
  analyseDirectory,
  createDefaultPolicy,
  type AnalysisResult,
  type PolicyConfig,
} from "@ghostdeps/core";
import { stat } from "node:fs/promises";
import { defaultAdapters } from "./adapters.js";
import type { CliConfig } from "./config.js";
import type { Io } from "./cli.js";
import { atOrAboveSeverity, findingGroup } from "@ghostdeps/core";
import { EXIT_OK, EXIT_THRESHOLD } from "./errors.js";
import { renderRepositorySummary } from "./output/human.js";
import { printJson } from "./output/json.js";

/**
 * Analyse a local directory. Static and offline: core's analyseDirectory reads
 * files through an inert handle, nothing in the repository runs, and skipped
 * files come back as scan-incompleteness findings.
 */
export async function analysePath(path: string, policy?: PolicyConfig): Promise<AnalysisResult> {
  return analyseDirectory(path, {
    adapters: defaultAdapters(),
    network: { mode: "offline" },
    recommend: createDefaultPolicy(policy ?? {}),
  });
}

/**
 * `ghostdeps scan [path]`. --json prints the complete schema-stable
 * AnalysisResult - never filtered, so the completeness and no-policy info
 * findings can't be hidden into a false all-clear. --severity filters the
 * human display only. --fail-on exits 1 when any finding (shown or not)
 * reaches the threshold, so CI can gate on it. Without --fail-on a successful
 * scan always exits 0: GhostDeps advises, it does not gate.
 */
export async function runScan(
  config: CliConfig,
  io: Io,
  analyse: (path: string, policy?: PolicyConfig) => Promise<AnalysisResult> = analysePath,
): Promise<number> {
  await assertDirectory(config.path);
  const result = await analyse(config.path, config.policy);
  if (config.json) {
    // Always the complete result (buildConfig rejects --severity with --json).
    printJson(result, io);
  } else {
    const min = config.severity;
    const shown =
      min === undefined
        ? result
        : { ...result, findings: result.findings.filter((f) => atOrAboveSeverity(f, min)) };
    io.stdout(renderRepositorySummary(shown));
    // Awareness findings never count (#234): hiding them under the filter
    // must not read as findings swept out of sight either.
    const hidden =
      result.findings.filter((f) => findingGroup(f) !== "awareness").length -
      shown.findings.filter((f) => findingGroup(f) !== "awareness").length;
    if (hidden > 0) {
      // Filtering must never read as a clean "Findings: none" all-clear.
      io.stdout(
        `(${hidden} finding${hidden === 1 ? "" : "s"} below the --severity ${min} filter hidden)`,
      );
    }
  }
  const failOn = config.failOn;
  // Awareness findings never affect the exit code (#234).
  if (
    failOn !== undefined &&
    result.findings.some((f) => findingGroup(f) !== "awareness" && atOrAboveSeverity(f, failOn))
  ) {
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
