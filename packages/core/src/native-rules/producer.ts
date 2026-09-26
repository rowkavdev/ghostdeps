/**
 * Snapshot-bound evidence producer boundary (#435). This module is inert: it
 * does not infer source facts, evaluate rules or emit findings. The existing
 * shape-only evaluator is NOT a producer and its synthetic inputs are not proof.
 */
import type { Dependency, RepositoryHandle } from "../types/index.js";
import type { UsageAnalysisReport } from "../adapter.js";
import type { NativeRule } from "./index.js";
import { collectNativeDeploymentEvidence } from "./deployment.js";

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
  /** Every binding-hop citation and every call-argument citation, re-read as bytes. */
  readonly lineage?: readonly NativeSourceProof[];
  readonly argumentSources?: readonly NativeSourceProof[];
}

/** Scope itself must be bounded and tied to the same snapshot. */
export interface NativeInspectedScope {
  readonly snapshotSha256: string;
  readonly files: readonly string[];
  readonly calls: readonly NativeSourceProof[];
  readonly complete: boolean;
}

/** A pattern is excluded only if checked, absent, and its inspected scope is complete. */
export type NativeIncompatibleCheck =
  | {
      readonly patternId: string;
      readonly state: "unchecked";
      readonly scope: NativeInspectedScope;
      readonly locations: readonly [];
    }
  | {
      readonly patternId: string;
      readonly state: "observed";
      readonly scope: NativeInspectedScope;
      readonly locations: readonly [NativeSourceProof, ...NativeSourceProof[]];
    }
  | {
      readonly patternId: string;
      readonly state: "absent";
      readonly scope: NativeInspectedScope & { readonly complete: true };
      readonly locations: readonly [];
      /** Bounded negative check grounded in this snapshot, not an unscoped assertion. */
      readonly negativeProof: NativeSourceProof;
    };

/** Unknown is explicit; a CI matrix or a bare engines declaration is not all targets. */
export interface NativeDeploymentTarget {
  readonly binding: "caller-asserted" | "verified";
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

/** Only source-validating code may ever populate this future output record.
 * Sealing requires all four pillars produced, verified repository binding,
 * and NO constituent `lineageVerification: "adapter-asserted"` stamp.
 * The matched-API pillar currently carries that stamp, so this producer
 * cannot seal it. A future lineage-link reconstruction or explicit
 * sealing-time ruling is needed; neither is implemented in this slice.
 */
export interface NativeEligibilityEvidence {
  readonly version: 1;
  readonly ruleId: string;
  readonly snapshotSha256: string;
  /** A produced envelope may only be sealed after repository binding is verified. */
  readonly binding: "verified";
  /** SHA-256 identity of the scanner-visible exclusion and scope policy. */
  readonly policy: string;
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
}

export type NativeProducerResult =
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "produced"; readonly evidence: NativeEligibilityEvidence };

/** Future implementations must read the repository and validate every proof. */
export type NativeEvidenceProducer = (input: NativeProducerInput) => Promise<NativeProducerResult>;

/** No positive path is shipped in slice 1. Never pass caller-supplied facts through. */
export const produceNativeEvidence: NativeEvidenceProducer = async (input) => {
  // This is a per-pillar measurement, not an eligibility verdict. An unknown
  // pillar or caller-asserted tree binding can never seal a produced envelope.
  await collectNativeDeploymentEvidence(input.repository, input.rule, input.snapshotSha256);
  return {
    status: "blocked",
    reason: "Source-validating native evidence production is not implemented.",
  };
};
