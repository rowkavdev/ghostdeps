/** Slice 7. An opaque seal over four source-validated components. No findings. */
import { createHash } from "node:crypto";
import type { Dependency, RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeEligibilityEvidence, NativeSourceProof } from "./producer.js";
import type { NativeDeploymentGateResult } from "./deployment.js";
import type { NativeMatchedApiResult } from "./matched-api.js";
import type { NativeIncompatibleResult } from "./incompatible.js";
import type { NativeSemanticResult } from "./semantic.js";
import { verifyNativeSnapshot } from "./snapshot.js";

/** Not exported: outside code cannot construct a sealed value structurally. */
const seal: unique symbol = Symbol("native-eligibility-seal");
export interface NativeSealedEvidence {
  readonly evidence: NativeEligibilityEvidence;
  readonly lineageVerification: "core-reconstructed";
  readonly [seal]: true;
}
export interface NativePillars {
  readonly deployment: NativeDeploymentGateResult;
  readonly matched: NativeMatchedApiResult | ReconstructedMatched;
  readonly incompatible: NativeIncompatibleResult | ReconstructedIncompatible;
  readonly semantic: NativeSemanticResult | ReconstructedSemantic;
}
/** Future core reconstruction can return this seam; no current producer does. */
type Reconstructed<T extends { readonly lineageVerification: string }> = T extends T
  ? Omit<T, "lineageVerification"> & { readonly lineageVerification: "core-reconstructed" }
  : never;
type ReconstructedMatched = Reconstructed<NativeMatchedApiResult>;
type ReconstructedIncompatible = Reconstructed<NativeIncompatibleResult>;
type ReconstructedSemantic = Reconstructed<NativeSemanticResult>;
export interface NativeSealRefusal {
  readonly reason:
    | "pillar-blocked"
    | "binding-unverified"
    | "adapter-lineage"
    | "identity-mismatch"
    | "coverage-incomplete"
    | "declaration-unverified"
    | "snapshot-unverified";
  readonly pillar?: keyof NativePillars;
  readonly detail: string;
}
export type NativeEnvelopeResult =
  | {
      readonly status: "blocked";
      readonly refusals: readonly [NativeSealRefusal, ...NativeSealRefusal[]];
      readonly pillars: NativePillars;
    }
  | { readonly status: "produced"; readonly evidence: NativeSealedEvidence };
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const validPath = (p: string): boolean =>
  !!p &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  p.normalize("NFC") === p &&
  p.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
/** Locate direct object members by JSON token boundaries, never by key substrings. */
function objectEntries(
  text: string,
  open: number,
): { key: string; start: number; valueStart: number; valueEnd: number }[] | null {
  if (text[open] !== "{") return null;
  const entries: { key: string; start: number; valueStart: number; valueEnd: number }[] = [];
  let pos = open + 1;
  const whitespace = (): void => {
    while (/\s/.test(text[pos] ?? "")) pos++;
  };
  while (pos < text.length) {
    whitespace();
    if (text[pos] === "}") return entries;
    if (text[pos] !== '"') return null;
    const start = pos++;
    let escaped = false;
    for (; pos < text.length; pos++) {
      const c = text[pos]!;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') break;
    }
    if (pos >= text.length) return null;
    const key = JSON.parse(text.slice(start, ++pos)) as string;
    whitespace();
    if (text[pos++] !== ":") return null;
    whitespace();
    const valueStart = pos;
    let nesting = 0,
      quoted = false;
    escaped = false;
    for (; pos < text.length; pos++) {
      const c = text[pos]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") nesting++;
      else if (c === "}" || c === "]") {
        if (nesting === 0) break;
        nesting--;
      } else if (c === "," && nesting === 0) break;
    }
    if (pos >= text.length || nesting !== 0 || quoted) return null;
    const valueEnd = pos;
    entries.push({ key, start, valueStart, valueEnd });
    if (text[pos] === "}") return entries;
    pos++;
  }
  return null;
}
/** Parse only direct package.json declaration fields, never lockfile transitives. */
async function declaration(
  repository: RepositoryHandle,
  dependency: Dependency,
  snapshotSha256: string,
  files: Map<string, RepositoryTreeEntry>,
): Promise<NativeSourceProof | null> {
  const file = dependency.declaredIn;
  if (
    dependency.project.ecosystem !== "javascript-typescript" ||
    !file.endsWith("package.json") ||
    !validPath(file) ||
    !files.has(file) ||
    !dependency.name ||
    !dependency.constraint
  )
    return null;
  const section =
    dependency.kind === "runtime"
      ? "dependencies"
      : dependency.kind === "dev"
        ? "devDependencies"
        : dependency.kind === "peer"
          ? "peerDependencies"
          : dependency.kind === "optional"
            ? "optionalDependencies"
            : null;
  if (!section) return null;
  let bytes: Uint8Array;
  try {
    bytes = (await repository.readFileBytes?.(file, files.get(file))) as Uint8Array;
  } catch {
    return null;
  }
  if (!(bytes instanceof Uint8Array) || bytes.length > 1_000_000) return null;
  let text: string, parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const deps = (parsed as Record<string, unknown>)[section];
  if (
    !deps ||
    typeof deps !== "object" ||
    Array.isArray(deps) ||
    (deps as Record<string, unknown>)[dependency.name] !== dependency.constraint
  )
    return null;
  // Require the literal citation to be the decoded key's direct member in
  // the actual top-level section. Escapes and duplicates block conservatively.
  const sections = objectEntries(text, text.search(/\S/))?.filter((e) => e.key === section);
  if (sections?.length !== 1) return null;
  const declarationSection = sections[0]!;
  if (
    text.slice(
      declarationSection.start,
      declarationSection.start + JSON.stringify(section).length,
    ) !== JSON.stringify(section)
  )
    return null;
  const sectionStart = declarationSection.valueStart;
  const sectionValue = text.slice(sectionStart, declarationSection.valueEnd).trimEnd();
  if (!sectionValue.startsWith("{") || !sectionValue.endsWith("}")) return null;
  const entries = objectEntries(text, sectionStart)?.filter((e) => e.key === dependency.name);
  if (entries?.length !== 1) return null;
  const entry = entries[0]!;
  const rawKey = JSON.stringify(dependency.name);
  if (text.slice(entry.start, entry.start + rawKey.length) !== rawKey) return null;
  if (text.slice(entry.valueStart, entry.valueEnd).trim() !== JSON.stringify(dependency.constraint))
    return null;
  const matchIndex = entry.start;
  const raw = Buffer.from(text.slice(matchIndex, entry.valueEnd).trimEnd(), "utf8");
  const before = Buffer.from(text.slice(0, matchIndex), "utf8");
  return {
    snapshotSha256,
    file,
    line: 1 + before.reduce((n, v) => n + (v === 10 ? 1 : 0), 0),
    span: { sha256: sha(raw) },
  };
}
export async function assembleNativeEnvelope(
  repository: RepositoryHandle,
  rule: NativeRule,
  dependency: Dependency,
  snapshotSha256: string,
  pillars: NativePillars,
): Promise<NativeEnvelopeResult> {
  const refusals: NativeSealRefusal[] = [];
  const refuse = (
    reason: NativeSealRefusal["reason"],
    detail: string,
    pillar?: keyof NativePillars,
  ): void => {
    refusals.push({ reason, detail, ...(pillar ? { pillar } : {}) });
  };
  const blocked = (): NativeEnvelopeResult => ({
    status: "blocked",
    refusals: refusals as [NativeSealRefusal, ...NativeSealRefusal[]],
    pillars,
  });
  const verified = await verifyNativeSnapshot(repository, snapshotSha256);
  if (verified.status !== "verified") refuse("snapshot-unverified", verified.reason);
  const names = ["deployment", "matched", "incompatible", "semantic"] as const;
  for (const name of names) {
    const p = pillars[name];
    if (p.status !== "pass") refuse("pillar-blocked", `${name} blocked`, name);
    if (p.binding !== "verified")
      refuse("binding-unverified", `${name} binding is not verified`, name);
    if (
      p.snapshotSha256 !== snapshotSha256 ||
      (verified.status === "verified" && p.policy !== verified.policy)
    )
      refuse("identity-mismatch", `${name} snapshot or policy differs`, name);
    if (
      name !== "deployment" &&
      "lineageVerification" in p &&
      p.lineageVerification !== "core-reconstructed"
    )
      refuse("adapter-lineage", `${name} lineage is not core-reconstructed`, name);
  }
  const matched = pillars.matched.matchedApis;
  const incompat = pillars.incompatible.checks;
  const semantics = pillars.semantic.checks;
  const targets = pillars.deployment.targets;
  const callIdentity = (proof: NativeSourceProof): string =>
    `${proof.snapshotSha256}\0${proof.file}\0${proof.line}\0${JSON.stringify(proof.span)}`;
  const callSet = new Set(matched.map((m) => callIdentity(m.source)));
  const expectedSemantics = matched.flatMap((m) =>
    rule.semanticDifferences.map((d) => `${callIdentity(m.source)}\0${d}`),
  );
  const actualSemantics = semantics.map((s) => `${callIdentity(s.use)}\0${s.difference}`);
  const expectedPatterns = [...rule.incompatibleUses].sort();
  const actualPatterns = incompat.map((c) => c.patternId).sort();
  const referenceComplete =
    matched.length > 0 &&
    callSet.size === matched.length &&
    same([...expectedSemantics].sort(), [...actualSemantics].sort()) &&
    same(expectedPatterns, actualPatterns) &&
    incompat.every(
      (c) => c.state === "absent" && c.scope.complete && c.scope.snapshotSha256 === snapshotSha256,
    ) &&
    semantics.every(
      (s) =>
        s.state === "inspected" && s.inspectedSource.length > 0 && callSet.has(callIdentity(s.use)),
    ) &&
    matched.every(
      (m) =>
        m.packageName === dependency.name &&
        m.arguments === "inspected" &&
        m.options === "inspected" &&
        m.source.snapshotSha256 === snapshotSha256,
    ) &&
    targets.length > 0 &&
    targets.every(
      (t) =>
        t.binding === "verified" &&
        t.authority === "deployment" &&
        t.declaration?.snapshotSha256 === snapshotSha256,
    );
  if (!referenceComplete)
    refuse(
      "coverage-incomplete",
      "Cross-pillar use, pattern, target or difference coverage is incomplete",
    );
  let declared: NativeSourceProof | null = null;
  if (verified.status === "verified") {
    try {
      const listing = await repository.listEntries?.();
      if (!listing?.complete || listing.limitations.length || listing.policy !== verified.policy)
        throw Error();
      declared = await declaration(
        repository,
        dependency,
        snapshotSha256,
        new Map(listing.entries.filter((e) => e.kind === "file").map((e) => [e.path, e])),
      );
    } catch {
      /* no declaration proof */
    }
  }
  if (
    !declared ||
    !rule.packages.includes(dependency.name) ||
    rule.ecosystem !== dependency.project.ecosystem
  )
    refuse("declaration-unverified", "Direct dependency declaration could not be proved");
  const final = await verifyNativeSnapshot(repository, snapshotSha256);
  if (
    final.status !== "verified" ||
    verified.status !== "verified" ||
    final.policy !== verified.policy
  )
    refuse("snapshot-unverified", "Snapshot changed during assembly");
  if (refusals.length) return blocked();
  const evidence: NativeEligibilityEvidence = {
    version: 1,
    ruleId: rule.id,
    snapshotSha256,
    binding: "verified",
    policy: final.status === "verified" ? final.policy : "",
    declaration: declared!,
    referencesComplete: true,
    matchedApis: matched,
    incompatibleChecks: incompat,
    deploymentTargets: targets,
    semanticChecks: semantics,
  };
  return {
    status: "produced",
    evidence: { evidence, lineageVerification: "core-reconstructed", [seal]: true },
  };
}
