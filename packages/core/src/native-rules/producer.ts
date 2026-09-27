/** Source-proof contracts for the validated native-evidence pipeline. */

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

/** Canonical bounded negative proof over every inspected eligible file, including
 * the empty set. An ordinary source span cannot prove multi-file absence.
 */
export interface NativeNegativeProof {
  readonly snapshotSha256: string;
  readonly policy: string;
  readonly patternId: string;
  readonly kind: "member-call" | "option-key-value" | "property-chain";
  readonly eligibility: "js-ts-pattern-files-v1";
  readonly listingSha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly sha256: string;
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
      readonly negativeProof: NativeNegativeProof;
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
