/** Snapshot-bound semantic pillar. Adapter flow claims remain adapter-asserted. */
import { createHash } from "node:crypto";
import type { RepositoryHandle, RepositoryTreeEntry } from "../types/index.js";
import type { NativeRule } from "./index.js";
import type { NativeSemanticCheck, NativeSourceProof } from "./producer.js";
import { verifyNativeSnapshot } from "./snapshot.js";
import type { NativeReferenceSpan } from "./matched-api.js";

export type NativeFlowKind =
  | "response-handling"
  | "status-check"
  | "parsed-response"
  | "error-handling"
  | "cancellation-propagation";
export interface NativeFlowInspection {
  readonly difference: string;
  readonly kind: NativeFlowKind;
  readonly call: NativeReferenceSpan;
  readonly lineage: readonly NativeReferenceSpan[];
  readonly state: "inspected" | "unknown" | "incompatible";
  readonly citations: readonly NativeReferenceSpan[];
  readonly explored: readonly NativeReferenceSpan[];
  readonly capped: boolean;
  readonly note?: string;
}
export interface NativeSemanticBlock {
  readonly difference: string;
  readonly call?: NativeReferenceSpan;
  readonly reason:
    | "snapshot-unverified"
    | "missing-flow"
    | "citation-inconsistent"
    | "incomplete-exploration"
    | "unknown"
    | "incompatible";
}
/** Core proves bytes and bounded citation consistency, NOT downstream binding
 * semantics. This component is never sealed eligibility evidence.
 */
export type NativeSemanticResult =
  | {
      readonly status: "blocked";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted";
      readonly policy: string | null;
      readonly checks: readonly NativeSemanticCheck[];
      readonly blocking: readonly [NativeSemanticBlock, ...NativeSemanticBlock[]];
    }
  | {
      readonly status: "pass";
      readonly snapshotSha256: string;
      readonly binding: "caller-asserted" | "verified";
      readonly lineageVerification: "adapter-asserted";
      readonly policy: string | null;
      readonly checks: readonly NativeSemanticCheck[];
      readonly blocking: readonly [];
    };
const kinds: readonly NativeFlowKind[] = [
  "response-handling",
  "status-check",
  "parsed-response",
  "error-handling",
  "cancellation-propagation",
];
const MAX_NODES = 2_000;
const validPath = (file: string): boolean =>
  !!file &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  file.normalize("NFC") === file &&
  file.split("/").every((p) => p !== "" && p !== "." && p !== "..");
const validSpan = (s: unknown): s is NativeReferenceSpan => {
  if (typeof s !== "object" || s === null) return false;
  const span = s as Partial<NativeReferenceSpan>;
  return (
    typeof span.file === "string" &&
    validPath(span.file) &&
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    span.start! >= 0 &&
    span.end! > span.start!
  );
};
const key = (s: NativeReferenceSpan): string => `${s.file}\0${s.start}\0${s.end}`;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const kindDifference = (kind: NativeFlowKind, rule: NativeRule): string | undefined => {
  if (rule.id !== "javascript-typescript/axios-to-fetch/v1") return undefined;
  const n = kind === "parsed-response" ? 1 : kind === "cancellation-propagation" ? 2 : 0;
  return rule.semanticDifferences[n];
};
/** Offset-shape validation, never a JavaScript AST or inferred control flow. */
function shape(kind: NativeFlowKind, text: string): boolean {
  if (kind === "status-check") return /\.(?:status|ok)$|\["(?:status|ok)"\]$/.test(text);
  if (kind === "parsed-response") return /\.data$|\["data"\]$/.test(text);
  if (kind === "error-handling")
    return /\.(?:code|response)$|\["(?:code|response)"\]$|^catch\s*\(/.test(text);
  if (kind === "cancellation-propagation")
    return /\bsignal\s*:|\bnew\s+AbortController\s*\(/.test(text);
  return /\bawait\b|\.then\s*\(/.test(text);
}
export async function collectNativeSemanticEvidence(
  repository: RepositoryHandle,
  rule: NativeRule,
  snapshotSha256: string,
  uses: readonly NativeReferenceSpan[],
  records: readonly NativeFlowInspection[],
): Promise<NativeSemanticResult> {
  const checks: NativeSemanticCheck[] = [];
  const blocking: NativeSemanticBlock[] = [];
  let binding: "caller-asserted" | "verified" = "caller-asserted";
  let policy: string | null = null;
  const fail = (
    difference: string,
    reason: NativeSemanticBlock["reason"],
    call?: NativeReferenceSpan,
  ): void => {
    blocking.push({ difference, reason, ...(call ? { call } : {}) });
  };
  const result = (): NativeSemanticResult =>
    blocking.length
      ? {
          status: "blocked",
          snapshotSha256,
          binding,
          lineageVerification: "adapter-asserted",
          policy,
          checks,
          blocking: blocking as [NativeSemanticBlock, ...NativeSemanticBlock[]],
        }
      : {
          status: "pass",
          snapshotSha256,
          binding,
          lineageVerification: "adapter-asserted",
          policy,
          checks,
          blocking: [],
        };
  const first = await verifyNativeSnapshot(repository, snapshotSha256);
  if (first.status !== "verified") {
    fail("*", "snapshot-unverified");
    return result();
  }
  binding = "verified";
  policy = first.policy;
  let entries: Map<string, RepositoryTreeEntry>;
  try {
    const listing = await repository.listEntries?.();
    if (!listing?.complete || listing.limitations.length || listing.policy !== policy)
      throw Error();
    entries = new Map(listing.entries.filter((e) => e.kind === "file").map((e) => [e.path, e]));
  } catch {
    fail("*", "snapshot-unverified");
    return result();
  }
  const bytes = new Map<string, Uint8Array>();
  const proof = async (s: NativeReferenceSpan): Promise<NativeSourceProof | null> => {
    if (
      !s ||
      typeof s.file !== "string" ||
      !validPath(s.file) ||
      !entries.has(s.file) ||
      !Number.isSafeInteger(s.start) ||
      !Number.isSafeInteger(s.end) ||
      s.start < 0 ||
      s.end <= s.start
    )
      return null;
    let b = bytes.get(s.file);
    if (!b) {
      try {
        b = await repository.readFileBytes?.(s.file, entries.get(s.file));
      } catch {
        return null;
      }
      if (!(b instanceof Uint8Array)) return null;
      bytes.set(s.file, b);
    }
    if (s.end > b.length) return null;
    return {
      snapshotSha256,
      file: s.file,
      line: 1 + b.subarray(0, s.start).reduce((n, v) => n + (v === 10 ? 1 : 0), 0),
      span: { sha256: hash(b.subarray(s.start, s.end)) },
    };
  };
  const safeUses = Array.isArray(uses) ? uses : [];
  const safeRecords = Array.isArray(records) ? records : [];
  if (
    !safeUses.length ||
    safeUses.some((s) => !validSpan(s)) ||
    new Set(safeUses.filter(validSpan).map(key)).size !== safeUses.length ||
    !Array.isArray(rule.semanticDifferences) ||
    !rule.semanticDifferences.length ||
    new Set(rule.semanticDifferences).size !== rule.semanticDifferences.length
  )
    fail("*", "missing-flow");
  for (const call of safeUses.filter(validSpan)) {
    const useProof = await proof(call);
    if (!useProof) {
      fail("*", "citation-inconsistent", call);
      continue;
    }
    for (const difference of rule.semanticDifferences) {
      const needed = kinds.filter((kind) => kindDifference(kind, rule) === difference);
      const matching = safeRecords.filter(
        (r) => r?.difference === difference && validSpan(r.call) && key(r.call) === key(call),
      );
      const collected: NativeSourceProof[] = [];
      let state: NativeSemanticCheck["state"] = "inspected";
      let reason: NativeSemanticBlock["reason"] | null = null;
      if (
        !needed.length ||
        matching.length !== needed.length ||
        needed.some((kind) => matching.filter((r) => r.kind === kind).length !== 1)
      )
        reason = "missing-flow";
      for (const record of matching) {
        if (
          !kinds.includes(record.kind) ||
          kindDifference(record.kind, rule) !== difference ||
          !Array.isArray(record.citations) ||
          !Array.isArray(record.explored) ||
          !Array.isArray(record.lineage) ||
          [...record.lineage, ...record.explored, ...record.citations].some((s) => !validSpan(s))
        ) {
          reason = "citation-inconsistent";
          continue;
        }
        if (
          record.capped ||
          record.explored.length > MAX_NODES ||
          !record.explored.some((s: NativeReferenceSpan) => key(s) === key(call))
        )
          reason = "incomplete-exploration";
        const all = [...record.lineage, ...record.explored, ...record.citations];
        const proven = await Promise.all(all.map(proof));
        if (
          proven.some((p) => !p) ||
          all.some(
            (s) =>
              s.file !== call.file &&
              !record.lineage.some((l: NativeReferenceSpan) => key(l) === key(s)),
          )
        ) {
          reason = "citation-inconsistent";
          continue;
        }
        for (const citation of record.citations) {
          const b = bytes.get(citation.file)!;
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              b.subarray(citation.start, citation.end),
            );
          } catch {
            reason = "citation-inconsistent";
            continue;
          }
          if (record.state !== "unknown" && !shape(record.kind, text))
            reason = "citation-inconsistent";
          if (
            !record.explored.some(
              (s: NativeReferenceSpan) =>
                s.file === citation.file && s.start <= citation.start && s.end >= citation.end,
            )
          )
            reason = "incomplete-exploration";
        }
        collected.push(
          ...record.citations.map(
            (_: NativeReferenceSpan, i: number) =>
              proven[record.lineage.length + record.explored.length + i]!,
          ),
        );
        if (record.state === "incompatible") state = "incompatible";
        else if (record.state !== "inspected" && state !== "incompatible") state = "unknown";
      }
      if (reason || state !== "inspected" || !collected.length) {
        if (reason || !collected.length) state = "unknown";
        fail(difference, reason ?? (state === "incompatible" ? "incompatible" : "unknown"), call);
      }
      checks.push({ difference, use: useProof, state, inspectedSource: collected });
    }
  }
  if (
    safeRecords.some(
      (r) =>
        !validSpan(r?.call) ||
        !safeUses.filter(validSpan).some((u) => key(u) === key(r.call)) ||
        !rule.semanticDifferences.includes(r.difference),
    )
  )
    fail("*", "missing-flow");
  const last = await verifyNativeSnapshot(repository, snapshotSha256);
  if (last.status !== "verified" || last.policy !== policy) {
    binding = "caller-asserted";
    policy = null;
    checks.length = 0;
    fail("*", "snapshot-unverified");
  }
  return result();
}
