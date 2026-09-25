/** Data-only native-alternative evaluator. This never edits sources or infers facts from imports. */
import type { Alternative, Confidence, Evidence } from "../types/index.js";
import type { NativeRule } from "./index.js";

/** Each fact is supplied by validated analysis of this exact project, not from a guessed target. */
export interface NativeEligibilityEvidence {
  version: 1;
  ecosystem: string;
  project: string;
  manifest: string;
  packageName: string;
  /** Digest of the exact read-only repository snapshot supplying all facts. */
  snapshotSha256: string;
  /** Complete source, script and configuration reference coverage. */
  referencesComplete: boolean;
  /** Every deployment target is known and is the named runtime, not just a CI version. */
  targets: readonly { runtime: string; minimumVersion: string; source: Evidence }[];
  /** All use sites, including aliases, re-exports, and wrappers; unresolved ones block. */
  uses: readonly {
    api: string;
    file: string;
    line: number;
    resolved: boolean;
    /** Enumerated options must be fully inspected, not merely omitted. */
    optionsChecked: boolean;
  }[];
  /** One source-backed check for every listed incompatible pattern. */
  incompatibleChecks: readonly {
    pattern: string;
    checked: boolean;
    observed: boolean;
    source: Evidence;
  }[];
  /** One source-backed review for every semantic difference at every use. */
  semanticChecks: readonly {
    difference: string;
    file: string;
    line: number;
    checked: boolean;
    source: Evidence;
  }[];
}

export type NativeDecision =
  | { status: "blocked"; reason: string }
  | {
      status: "candidate";
      ruleId: string;
      matchedApis: string[];
      excludedIncompatibilities: string[];
      alternative: Alternative;
      evidence: Evidence[];
    };

const block = (reason: string): NativeDecision => ({ status: "blocked", reason });
const version = (text: string): number[] | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? match.slice(1).map(Number) : undefined;
};
const meets = (actual: string, minimum: string): boolean => {
  const a = version(actual),
    b = version(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
};
const safeEvidence = (e: Evidence | undefined): boolean =>
  Boolean(
    e &&
    e.kind === "deployment-runtime-floor" &&
    e.file &&
    e.statement &&
    !e.file.startsWith("/") &&
    !e.file.split("/").includes(".."),
  );

/** Shape-only evaluator. This does not validate that evidence came from source.
 * No caller may convert a candidate to a Finding without a separate core-owned
 * source-validating producer, which this slice does not provide.
 */
export function evaluateNativeRule(
  rule: NativeRule,
  facts: NativeEligibilityEvidence,
): NativeDecision {
  if (
    facts.version !== 1 ||
    rule.ecosystem !== facts.ecosystem ||
    !rule.packages.includes(facts.packageName) ||
    !facts.project ||
    !facts.manifest ||
    !/^[a-f0-9]{64}$/.test(facts.snapshotSha256)
  )
    return block("Rule and exact project declaration do not match.");
  if (!facts.referencesComplete) return block("Reference coverage is unavailable.");
  if (
    !Array.isArray(facts.targets) ||
    !Array.isArray(facts.uses) ||
    !Array.isArray(facts.incompatibleChecks) ||
    !Array.isArray(facts.semanticChecks)
  )
    return block("Evidence is malformed or unavailable.");
  if (
    !rule.id ||
    !rule.nativeCapability ||
    !rule.coveredApis.length ||
    !rule.incompatibleUses.length ||
    !rule.semanticDifferences.length
  )
    return block("Rule has no bounded evidence contract.");
  if (
    !facts.targets.length ||
    !Object.keys(rule.minimumRuntime).length ||
    facts.targets.some(
      (t) =>
        !safeEvidence(t.source) ||
        !Object.hasOwn(rule.minimumRuntime, t.runtime) ||
        !meets(t.minimumVersion, rule.minimumRuntime[t.runtime]!),
    )
  )
    return block("A supported deployment runtime floor is not proven for every target.");
  if (
    !facts.uses.length ||
    facts.uses.some(
      (u) =>
        !u.resolved ||
        !u.optionsChecked ||
        !u.file ||
        !Number.isSafeInteger(u.line) ||
        u.line < 1 ||
        !rule.coveredApis.includes(u.api),
    )
  )
    return block("At least one use is unresolved, unexamined or outside the covered APIs.");
  if (
    rule.incompatibleUses.length !== facts.incompatibleChecks.length ||
    rule.incompatibleUses.some(
      (pattern) =>
        facts.incompatibleChecks.filter((check) => check.pattern === pattern).length !== 1,
    ) ||
    facts.incompatibleChecks.some(
      (check) =>
        !check.checked ||
        !check.source?.file ||
        !check.source.statement ||
        check.source.kind !== "native-incompatibility-checked",
    )
  )
    return block("Incompatibility coverage is unavailable.");
  if (facts.incompatibleChecks.some((check) => check.observed))
    return block("Incompatible usage was observed; no replacement verdict is available.");
  if (
    facts.semanticChecks.length !== facts.uses.length * rule.semanticDifferences.length ||
    facts.uses.some((use) =>
      rule.semanticDifferences.some(
        (difference) =>
          facts.semanticChecks.filter(
            (check) =>
              check.difference === difference && check.file === use.file && check.line === use.line,
          ).length !== 1,
      ),
    ) ||
    facts.semanticChecks.some(
      (check) =>
        !check.checked ||
        !check.source?.file ||
        !check.source.statement ||
        check.source.kind !== "native-semantic-checked",
    )
  )
    return block("Semantic differences have not been accounted for at every use.");
  const matchedApis = [...new Set(facts.uses.map((u) => u.api))].sort();
  const evidence: Evidence[] = [
    ...facts.targets.map((t) => t.source),
    ...facts.incompatibleChecks.map((check) => check.source),
    ...facts.semanticChecks.map((check) => check.source),
    ...facts.uses.map((u) => ({
      kind: "native-api-matched",
      statement: `${u.api} is covered by ${rule.nativeCapability}`,
      file: u.file,
      line: u.line,
    })),
  ];
  const confidence: Confidence = "medium";
  return {
    status: "candidate",
    ruleId: rule.id,
    matchedApis,
    excludedIncompatibilities: [...rule.incompatibleUses],
    evidence,
    alternative: {
      nativeCapability: rule.nativeCapability,
      minimumRuntime: { ...rule.minimumRuntime },
      coveredApis: matchedApis,
      incompatibilities: [],
      confidence,
    },
  };
}
