/**
 * Native replacement rule schema (docs/architecture.md, "Native replacement
 * rules"). Rules are data with tests, not vibes. Seed dataset research:
 * issue #64 (e18e/module-replacements, min versions from Node docs).
 * No native replacement finding is shipped by this inert data contract. A
 * source-validating producer must first establish runtime and semantic facts.
 */

/** One native-replacement rule for one ecosystem. */
export interface NativeRule {
  /** Stable rule identity; version changes when coverage or semantics change. */
  id: string;
  ecosystem: string;
  /** Package(s) this rule applies to (e.g. ["axios", "node-fetch", "cross-fetch"]). */
  packages: string[];
  /** The native capability, e.g. "fetch()". */
  nativeCapability: string;
  /** Minimum runtime/language versions, e.g. { "node": "18.0.0" }. */
  minimumRuntime: Record<string, string>;
  /** Usage APIs the native capability covers, e.g. ["get", "json"]. */
  coveredApis: string[];
  /** Usage patterns that disqualify the replacement, e.g. ["interceptors", "adapter", "CancelToken"]. */
  incompatibleUses: string[];
  /** Behavioural differences a user must accept, in plain language. */
  semanticDifferences: string[];
  /** When the rule may fire at high confidence. */
  confidenceCriteria: string[];
  /** Links to docs/specs justifying the mapping. */
  references: string[];
}

export {
  evaluateNativeRule,
  type NativeEligibilityEvidence,
  type NativeDecision,
} from "./evaluate.js";
