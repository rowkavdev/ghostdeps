import {
  analyseRepository,
  scanCompletenessFindings,
  createDefaultPolicy,
  type EngineRuleConfig,
  type AnalysisResult,
  FsRepositoryHandle,
  normaliseAnalysisResult,
  severityOf,
  capConfidence,
  type PolicyConfig,
} from "@ghostdeps/core";
import { stat } from "node:fs/promises";
import { defaultAdapters } from "./adapters.js";
import { evaluateNativeProduction } from "@ghostdeps/javascript-typescript";
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
/** Engine-emitted rules (#58 duplicates) take the same disable/downgrade config as policy rules. */
function engineRuleConfig(policy: PolicyConfig | undefined): { ruleConfig?: EngineRuleConfig } {
  const ruleConfig: EngineRuleConfig = {};
  if (policy?.disabled) ruleConfig.disabled = policy.disabled;
  if (policy?.downgrade) ruleConfig.downgrade = policy.downgrade;
  return Object.keys(ruleConfig).length > 0 ? { ruleConfig } : {};
}

export async function analysePath(
  path: string,
  policy?: PolicyConfig,
  fixtureRootsOverride?: string,
): Promise<AnalysisResult> {
  // Repo-config fixture scope (#354): a committed .ghostdeps.json narrows the
  // analysed view, and the result discloses it. Without a config file the scan
  // matches the unscoped view and the legacy output stays byte-identical.
  // A present --fixture-roots payload replaces the committed roots for the run;
  // the committed file is still read, so a malformed config never launders.
  const handle = await FsRepositoryHandle.open(path, {
    fixtureScope: true,
    ...(fixtureRootsOverride !== undefined ? { fixtureRootsOverride } : {}),
  });
  const result = await analyseRepository(handle, {
    ...engineRuleConfig(policy),
    adapters: defaultAdapters(),
    network: { mode: "offline" },
    recommend: createDefaultPolicy(policy ?? {}),
    scanCompleteness: scanCompletenessFindings(handle.scan),
    // Only a real configuration is disclosed: a source "none" record is the
    // empty scope, so propagating it would change legacy default output.
    ...(handle.scan.scope && handle.scan.scope.source !== "none"
      ? { scanScope: handle.scan.scope }
      : {}),
  });
  const native = await evaluateNativeProduction(handle, result.dependencies);
  const disabled = new Set(policy?.disabled ?? []);
  const allowed = native.findings
    .filter((finding) => !disabled.has(finding.rule ?? ""))
    .map((finding) => ({
      ...finding,
      confidence: policy?.downgrade?.[finding.rule ?? ""]
        ? capConfidence(finding.confidence, policy.downgrade[finding.rule ?? ""]!)
        : finding.confidence,
    }));
  return normaliseAnalysisResult({
    ...result,
    findings: [
      ...result.findings,
      ...allowed.map((finding) => ({ ...finding, severity: severityOf(finding) })),
    ],
    ...(native.evaluations.length ? { nativeEvaluations: native.evaluations } : {}),
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
  analyse: (
    path: string,
    policy?: PolicyConfig,
    fixtureRootsOverride?: string,
  ) => Promise<AnalysisResult> = analysePath,
): Promise<number> {
  await assertDirectory(config.path);
  const result = await analyse(config.path, config.policy, config.fixtureRoots);
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
    // Non-capping awareness and source-backed facts do not count as hidden
    // findings (#385 renders facts in their own section).
    const hidden =
      result.findings.filter((f) => counted(f)).length -
      shown.findings.filter((f) => counted(f)).length;
    if (hidden > 0) {
      // Filtering must never read as a clean "Findings: none" all-clear.
      io.stdout(
        `(${hidden} finding${hidden === 1 ? "" : "s"} below the --severity ${min} filter hidden)`,
      );
    }
  }
  const failOn = config.failOn;
  // Awareness and factual health observations never affect the exit code.
  if (
    failOn !== undefined &&
    result.findings.some((f) => counted(f) && atOrAboveSeverity(f, failOn))
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

/** Gating/count contract: neither awareness nor health facts are verdicts. */
function counted(finding: AnalysisResult["findings"][number]): boolean {
  const group = findingGroup(finding);
  return group !== "awareness" && group !== "fact";
}
