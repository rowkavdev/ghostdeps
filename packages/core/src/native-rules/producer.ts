/**
 * Snapshot-bound evidence producer boundary (#435). This module is inert: it
 * does not infer source facts, evaluate rules or emit findings. The existing
 * shape-only evaluator is NOT a producer and its synthetic inputs are not proof.
 */
import type { Dependency, RepositoryHandle } from "../types/index.js";
import type { UsageAnalysisReport } from "../adapter.js";
import type { NativeRule } from "./index.js";

/** Location in a specific immutable repository snapshot; all paths are relative. */
export interface NativeSourceProof {
  readonly snapshotSha256: string;
  readonly file: string;
  readonly line: number;
  /** Exact source span or digest; a plain human-written assertion is not proof. */
  readonly span: { readonly start: number; readonly end: number } | { readonly sha256: string };
}

/** Calls and arguments must be traced beyond an import/member name. */
export interface NativeMatchedApi {
  readonly packageName: string;
  readonly binding: string;
  readonly callTarget: string;
  readonly api: string;
  readonly source: NativeSourceProof;
  readonly arguments: "inspected" | "unknown";
  readonly options: "inspected" | "unknown";
  readonly resolution: "direct" | "alias" | "wrapper" | "re-export" | "indirect-unknown";
}

/** Scope itself must be bounded and tied to the same snapshot. */
export interface NativeInspectedScope {
  readonly snapshotSha256: string;
  readonly files: readonly string[];
  readonly calls: readonly NativeSourceProof[];
  readonly complete: boolean;
}

/** A pattern is excluded only if checked, absent, and its inspected scope is complete. */
export interface NativeIncompatibleCheck {
  readonly patternId: string;
  readonly scope: NativeInspectedScope;
  /** Absent is reserved for a complete negative-check scope. */
  readonly state: "unchecked" | "observed" | "absent";
  /** Present for observed use; absence needs the bounded negative-check scope. */
  readonly locations: readonly NativeSourceProof[];
}

/** Unknown is explicit; a CI matrix or a bare engines declaration is not all targets. */
export interface NativeDeploymentTarget {
  readonly target: string;
  readonly runtime: string;
  readonly minimumVersion: string | null;
  readonly declaration: NativeSourceProof | null;
  readonly declarationText: string | null;
  readonly authority: "deployment" | "ci-only" | "unverified";
}

/** One inspected rule-specific difference at one use, including downstream flows. */
export interface NativeSemanticCheck {
  readonly difference: string;
  readonly use: NativeSourceProof;
  readonly state: "inspected" | "unknown" | "incompatible";
  readonly inspectedSource: readonly NativeSourceProof[];
}

/** Only source-validating code may ever populate this future output record. */
export interface NativeProducedEvidence {
  readonly version: 1;
  readonly ruleId: string;
  readonly snapshotSha256: string;
  readonly declaration: NativeSourceProof;
  readonly referencesComplete: boolean;
  readonly matchedApis: readonly NativeMatchedApi[];
  readonly incompatibleChecks: readonly NativeIncompatibleCheck[];
  readonly deploymentTargets: readonly NativeDeploymentTarget[];
  readonly semanticChecks: readonly NativeSemanticCheck[];
}

/** Inputs are leads to verify, not a caller's claims of native eligibility. */
export interface NativeProducerInput {
  readonly rule: NativeRule;
  readonly snapshotSha256: string;
  readonly repository: RepositoryHandle;
  readonly dependency: Dependency;
  readonly references: UsageAnalysisReport;
  /** Enumerated target leads, including unknown targets, to verify against source. */
  readonly deploymentTargets: readonly { readonly target: string; readonly runtime: string }[];
}

export type NativeProducerResult =
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "produced"; readonly evidence: NativeProducedEvidence };

/** Future implementations must read the repository and validate every proof. */
export type NativeEvidenceProducer = (input: NativeProducerInput) => Promise<NativeProducerResult>;

/** No positive path is shipped in slice 1. Never pass caller-supplied facts through. */
export const produceNativeEvidence: NativeEvidenceProducer = async (_input) => ({
  status: "blocked",
  reason: "Source-validating native evidence production is not implemented.",
});
