/** Production-only native evaluation. Adapter observations are leads; each pillar
 * re-reads the scanner-bound snapshot before the opaque seal can be minted. */
import {
  JS_NATIVE_RULES,
  mintNativeSnapshot,
  collectNativeDeploymentEvidence,
  collectNativeMatchedApiEvidence,
  collectNativeIncompatibleEvidence,
  collectNativeSemanticEvidence,
  assembleNativeEnvelope,
  evaluateNativePolicy,
  type Dependency,
  type Finding,
  type NativeEvaluation,
  type RepositoryHandle,
} from "@ghostdeps/core";
import { findMatchedApiReferences } from "./matched-apis.js";
import { inspectIncompatiblePatterns } from "./pattern-inspections.js";
import { inspectSemanticFlows } from "./semantic-inspections.js";

export interface NativeProductionOutput {
  readonly findings: Finding[];
  readonly evaluations: NativeEvaluation[];
}

/** No caller-supplied scans, pillars, rule objects, stamps or snapshot digest. */
export async function evaluateNativeProduction(
  repository: RepositoryHandle,
  dependencies: readonly Dependency[],
): Promise<NativeProductionOutput> {
  const findings: Finding[] = [];
  const evaluations: NativeEvaluation[] = [];
  const candidates = dependencies.flatMap((dependency) =>
    JS_NATIVE_RULES.filter(
      (rule) =>
        rule.ecosystem === dependency.project.ecosystem && rule.packages.includes(dependency.name),
    ).map((rule) => ({ dependency, rule })),
  );
  if (!candidates.length) return { findings, evaluations };
  const snapshot = await mintNativeSnapshot(repository);
  for (const { dependency, rule } of candidates) {
    const identity = {
      ruleId: rule.id,
      dependency: dependency.name,
      declaringManifest: { ecosystem: dependency.project.ecosystem, path: dependency.declaredIn },
    };
    if (snapshot.status !== "verified") {
      evaluations.push({
        ...identity,
        status: "blocked",
        pillar: "snapshot",
        reason: snapshot.reason,
      });
      continue;
    }
    try {
      const scan = await findMatchedApiReferences(repository, dependency.name);
      if (!scan.references.length && !scan.limitations.length) {
        evaluations.push({ ...identity, status: "no-verdict", reason: "no matched call evidence" });
        continue;
      }
      const deployment = await collectNativeDeploymentEvidence(
        repository,
        rule,
        snapshot.snapshotSha256,
      );
      const matched = await collectNativeMatchedApiEvidence(
        repository,
        rule,
        snapshot.snapshotSha256,
        scan,
      );
      const kinds = rule.incompatiblePatternKinds;
      const patterns = rule.incompatibleUses
        .filter((patternId) => kinds?.[patternId])
        .map((patternId) => ({ patternId, kind: kinds![patternId]! }));
      const patternInspections = await inspectIncompatiblePatterns(repository, patterns);
      const incompatible = await collectNativeIncompatibleEvidence(
        repository,
        rule,
        snapshot.snapshotSha256,
        patternInspections,
      );
      const calls = scan.references.flatMap((ref) =>
        ref.span && !["script", "config"].includes(ref.resolution) ? [ref.span] : [],
      );
      const flows = await inspectSemanticFlows(repository, scan.references);
      const semantic = await collectNativeSemanticEvidence(
        repository,
        rule,
        snapshot.snapshotSha256,
        calls,
        flows,
      );
      const envelope = await assembleNativeEnvelope(
        repository,
        rule,
        dependency,
        snapshot.snapshotSha256,
        {
          deployment,
          matched,
          incompatible,
          semantic,
        },
      );
      if (envelope.status === "blocked") {
        const first = envelope.refusals[0]!;
        const pillar =
          first.pillar ?? (first.reason === "snapshot-unverified" ? "snapshot" : "seal");
        const detail =
          pillar === "seal" || pillar === "snapshot"
            ? first.reason
            : ({ deployment, matched, incompatible, semantic }[pillar].blocking[0]?.reason ??
              first.reason);
        evaluations.push({ ...identity, status: "blocked", pillar, reason: detail });
        continue;
      }
      const decision = await evaluateNativePolicy(
        repository,
        rule,
        snapshot.snapshotSha256,
        envelope,
      );
      if (decision.status === "blocked") {
        evaluations.push({
          ...identity,
          status: "blocked",
          pillar: decision.pillar ?? "policy",
          reason: decision.reason,
        });
      } else {
        findings.push({
          ...decision.finding,
          declaringManifest: {
            ecosystem: dependency.project.ecosystem,
            path: dependency.declaredIn,
          },
        });
        evaluations.push({ ...identity, status: "produced" });
      }
    } catch {
      // Source/parse/read errors must never become a guessed pass or leak raw paths.
      evaluations.push({
        ...identity,
        status: "blocked",
        pillar: "producer",
        reason: "source inspection failed",
      });
    }
  }
  return { findings, evaluations };
}
