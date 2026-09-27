/** Policy gate for a live assembler seal. No production pipeline calls this yet.
 * The private seal attests assembly, not producer provenance; slice 10 closes
 * the synthetic pillar seam before this gate is wired into scanning.
 */
import type { Finding, RepositoryHandle } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeEnvelopeResult } from "./seal.js";
import { liveNativeSealRecord } from "./seal.js";
import { verifyNativeSnapshot } from "./snapshot.js";
import { nativeRuleIdentity } from "./rule-identity.js";

export type NativePolicyResult =
  | { readonly status: "blocked"; readonly reason: string; readonly pillar?: string }
  | { readonly status: "produced"; readonly finding: Finding };
const blocked = (reason: string, pillar?: string): NativePolicyResult => ({
  status: "blocked",
  reason,
  ...(pillar ? { pillar } : {}),
});
const version = (value: string): number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
};
const meets = (actual: string, minimum: string): boolean => {
  const a = version(actual),
    b = version(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return true;
};
const source = (value: { snapshotSha256: string; file: string; line: number }): boolean =>
  /^[a-f0-9]{64}$/.test(value.snapshotSha256) &&
  !!value.file &&
  Number.isSafeInteger(value.line) &&
  value.line >= 1;

export async function evaluateNativePolicy(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
  envelope: NativeEnvelopeResult,
): Promise<NativePolicyResult> {
  if (!envelope || envelope.status !== "produced") {
    const refusal = envelope?.status === "blocked" ? envelope.refusals?.[0] : null;
    return blocked(refusal?.reason ?? "unsealed-envelope", refusal?.pillar);
  }
  const record = liveNativeSealRecord(envelope.evidence);
  if (!record) return blocked("not-live-assembler-seal");
  const e = record.evidence;
  if (e.ruleId !== rule.id || !/\/v\d+$/.test(rule.id)) return blocked("rule-version-mismatch");
  if (record.ruleIdentity !== nativeRuleIdentity(rule)) return blocked("rule-content-mismatch");
  if (!e.referencesComplete || e.binding !== "verified")
    return blocked("incomplete-sealed-evidence");
  if (
    e.version !== 1 ||
    !rule.id ||
    e.ruleId !== rule.id ||
    !/\/v\d+$/.test(rule.id) ||
    !rule.packages.length ||
    !rule.nativeCapability ||
    !rule.coveredApis.length ||
    !rule.incompatibleUses.length ||
    !rule.semanticDifferences.length
  )
    return blocked("rule-version-mismatch");
  if (e.snapshotSha256 !== snapshotSha256) return blocked("snapshot-identity-mismatch");
  const first = await verifyNativeSnapshot(repository, snapshotSha256);
  if (first.status !== "verified") return blocked(`snapshot-unverified:${first.reason}`);
  if (e.policy !== first.policy) return blocked("policy-identity-mismatch");
  if (!source(e.declaration) || e.declaration.snapshotSha256 !== snapshotSha256)
    return blocked("declaration-provenance-invalid");
  if (
    !e.matchedApis.length ||
    e.matchedApis.some(
      (m) =>
        !rule.packages.includes(m.packageName) ||
        !rule.coveredApis.includes(m.api) ||
        m.arguments !== "inspected" ||
        m.options !== "inspected" ||
        m.source.snapshotSha256 !== snapshotSha256 ||
        !source(m.source),
    )
  )
    return blocked("matched-api-policy-invalid", "matched");
  const checks = e.incompatibleChecks;
  if (
    checks.length !== rule.incompatibleUses.length ||
    rule.incompatibleUses.some(
      (pattern) => checks.filter((c) => c.patternId === pattern).length !== 1,
    ) ||
    checks.some(
      (c) =>
        c.state !== "absent" ||
        !c.scope.complete ||
        c.scope.snapshotSha256 !== snapshotSha256 ||
        c.negativeProof.snapshotSha256 !== snapshotSha256 ||
        c.negativeProof.policy !== e.policy,
    )
  )
    return blocked("incompatible-coverage-invalid", "incompatible");
  const identity = (p: { file: string; line: number; span: unknown }) =>
    `${p.file}\0${p.line}\0${JSON.stringify(p.span)}`;
  const expected = e.matchedApis.flatMap((m) =>
    rule.semanticDifferences.map((d) => `${identity(m.source)}\0${d}`),
  );
  const actual = e.semanticChecks.map((c) => `${identity(c.use)}\0${c.difference}`);
  expected.sort();
  actual.sort();
  if (
    expected.length !== actual.length ||
    expected.some((x, i) => x !== actual[i]) ||
    e.semanticChecks.some(
      (c) =>
        c.state !== "inspected" ||
        c.use.snapshotSha256 !== snapshotSha256 ||
        !c.inspectedSource.length,
    )
  )
    return blocked("semantic-coverage-invalid", "semantic");
  if (
    !e.deploymentTargets.length ||
    !Object.keys(rule.minimumRuntime).length ||
    e.deploymentTargets.some(
      (t) =>
        t.binding !== "verified" ||
        t.authority !== "deployment" ||
        !t.declaration ||
        t.declaration.snapshotSha256 !== snapshotSha256 ||
        !t.minimumVersion ||
        !Object.hasOwn(rule.minimumRuntime, t.runtime) ||
        !meets(t.minimumVersion, rule.minimumRuntime[t.runtime]!),
    )
  )
    return blocked("deployment-floor-invalid", "deployment");
  const final = await verifyNativeSnapshot(repository, snapshotSha256);
  if (final.status !== "verified" || final.policy !== first.policy)
    return blocked("snapshot-changed-during-policy");
  const files = [...new Set(e.matchedApis.map((m) => m.source.file))];
  const evidence: Finding["evidence"] = [
    {
      kind: "native-direct-declaration",
      statement: `${e.matchedApis[0]!.packageName} is directly declared`,
      file: e.declaration.file,
      line: e.declaration.line,
    },
    ...e.matchedApis.map((m) => ({
      kind: "native-api-matched",
      statement: `${m.api} is covered by ${rule.nativeCapability}`,
      file: m.source.file,
      line: m.source.line,
    })),
    ...checks.map((c) => ({
      kind: "native-incompatibility-excluded",
      statement: `${c.patternId} absent in complete snapshot-bound scope (${c.state === "absent" ? c.negativeProof.sha256 : "unverified"})`,
    })),
    ...e.deploymentTargets.map((t) => ({
      kind: "deployment-runtime-floor",
      statement: `${t.target}: ${t.runtime} ${t.minimumVersion}`,
      file: t.declaration!.file,
      line: t.declaration!.line,
    })),
  ];
  return {
    status: "produced",
    finding: {
      kind: "potentially-unnecessary",
      rule: rule.id,
      dependency: e.matchedApis[0]!.packageName,
      summary: `${e.matchedApis[0]!.packageName} may have a native alternative`,
      recommendation: `Review ${rule.nativeCapability} as a replacement after checking behavior and target runtimes.`,
      evidence,
      confidence: "medium",
      limitations: [],
      affectedFiles: files,
    },
  };
}
