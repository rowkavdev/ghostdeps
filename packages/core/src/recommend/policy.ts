/**
 * Default recommendation policy (#121): turns adapter facts into verdicts.
 *
 * Conservative by design (ADR 0004, architecture.md): uncertainty
 * downgrades a verdict, never upgrades it, and ambiguous evidence never
 * produces a removal verdict. Each rule is a pure function over facts,
 * registered by id so config can disable or downgrade it.
 */
import type { RecommendationInput, RecommendationPolicy } from "../engine/analyse.js";
import type { Confidence, Dependency, Finding, Usage } from "../types/index.js";
import {
  DEFAULT_TOOLING_ALLOWLIST,
  isAllowlisted,
  mergeAllowlists,
  type ToolingAllowlist,
} from "./allowlist.js";
import { isNonShippedPath } from "./paths.js";

export interface PolicyConfig {
  /** Rule ids to turn off. */
  disabled?: readonly string[];
  /** Cap a rule's confidence (never raises it). */
  downgrade?: Readonly<Record<string, Confidence>>;
  /** Extra allowlist entries per ecosystem, merged onto the defaults. */
  allowlist?: Readonly<Record<string, Partial<ToolingAllowlist>>>;
  /** Ecosystems whose build strips types, enabling the type-only rule. */
  typeStrippingEcosystems?: readonly string[];
}

/** Facts pre-indexed once per policy run. */
export interface PolicyContext {
  input: RecommendationInput;
  /** Usages at head. Never includes `removedInPr` usages. */
  usagesByDependency: ReadonlyMap<string, readonly Usage[]>;
  /** PR mode (#101): usages on lines the pull request removed. */
  removedInPrByDependency: ReadonlyMap<string, readonly Usage[]>;
  allowlists: Readonly<Record<string, ToolingAllowlist>>;
  typeStrippingEcosystems: ReadonlySet<string>;
  /** Ecosystems whose adapter checked script/config references (see referenceAnalysedEcosystems). */
  referenceAnalysedEcosystems: ReadonlySet<string>;
  /** Direct dependency names another direct dependency pulls in (from lockfile graphs). */
  requiredByOtherDirect: ReadonlyMap<string, string>;
}

export interface PolicyRule {
  id: string;
  /** Evaluate one dependency. Return at most one finding. */
  evaluate(dependency: Dependency, context: PolicyContext): Finding | undefined;
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

const key = (d: Dependency): string => `${d.project.ecosystem}\0${d.name}`;

function usagesOf(d: Dependency, context: PolicyContext): readonly Usage[] {
  return context.usagesByDependency.get(key(d)) ?? [];
}

/** @types/foo counts as used when foo is used in a TypeScript-ecosystem repo. */
function typesCompanionUsed(d: Dependency, context: PolicyContext): string | undefined {
  if (d.project.ecosystem !== "javascript-typescript" || !d.name.startsWith("@types/")) {
    return undefined;
  }
  const bare = d.name.slice("@types/".length);
  // @types/scope__pkg describes @scope/pkg.
  const target = bare.includes("__") ? `@${bare.replace("__", "/")}` : bare;
  const used = context.usagesByDependency.get(`${d.project.ecosystem}\0${target}`);
  return used && used.length > 0 ? target : undefined;
}

/**
 * Shared preconditions for the no-imports rules: usage analysis ran, the
 * dependency is a plain registry runtime/dev dep, and nothing counts as
 * usage (imports, any via, the allowlist, a used @types companion).
 */
function hasNoUsageEvidence(d: Dependency, context: PolicyContext): boolean {
  const ecosystem = d.project.ecosystem;
  if (!context.input.usageAnalysedEcosystems.has(ecosystem)) return false;
  // Peer/optional handling is out of scope (#11): no verdicts.
  if (d.kind === "peer" || d.kind === "optional") return false;
  // Non-registry specifiers (workspace/link/file/git) are not removal candidates here.
  if (d.specifier && d.specifier.type !== "registry") return false;
  if (usagesOf(d, context).length > 0) return false;
  if (isAllowlisted(d.name, ecosystem, context.allowlists)) return false;
  if (typesCompanionUsed(d, context)) return false;
  return true;
}

/**
 * Rules whose findings are anchored on the manifest declaration (#198):
 * their evidence carries `file: declaredIn` plus `line` when known.
 */
export const DECLARATION_ANCHORED_RULES: ReadonlySet<string> = new Set([
  "unused",
  "removed-last-usage",
  "unverified-no-imports",
  "should-be-dev",
]);

/** Evidence kinds that point at the declaration (file + line when known). */
export const DECLARATION_EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  "no-usage-found",
  "declared-in",
]);

const atDeclaration = (d: Dependency): { file: string; line?: number } =>
  d.declaredLine === undefined
    ? { file: d.declaredIn }
    : { file: d.declaredIn, line: d.declaredLine };

function noImportsEvidence(d: Dependency) {
  return {
    kind: "no-usage-found",
    statement: `no import, require or dynamic import of ${d.name} found`,
    ...atDeclaration(d),
  };
}

/** "unused": a removal verdict, only when every evidence source was checked. */
const unusedRule: PolicyRule = {
  id: "unused",
  evaluate(d, context) {
    if (!hasNoUsageEvidence(d, context)) return undefined;
    if (!context.referenceAnalysedEcosystems.has(d.project.ecosystem)) return undefined;
    if (context.requiredByOtherDirect.has(key(d))) return undefined;
    return {
      kind: "unused",
      rule: "unused",
      dependency: d.name,
      summary: `${d.name} is declared but never used`,
      recommendation: `Remove ${d.name} from ${d.declaredIn}.`,
      evidence: [
        noImportsEvidence(d),
        {
          kind: "no-reference-found",
          statement: `no script, bin or config reference to ${d.name} found`,
        },
        {
          kind: "not-allowlisted",
          statement: `${d.name} is not on the dev-tooling allowlist`,
        },
      ],
      confidence: "high",
      limitations: [],
      affectedFiles: [d.declaredIn],
    };
  },
};

/** Most removed-line evidence records one PR-scoped finding carries. */
const MAX_REMOVED_EVIDENCE = 20;

/**
 * "removed-last-usage" (#101, PR mode only): the dependency is still
 * declared, nothing uses it at head, and the adapter found it on a line this
 * pull request removed. Ecosystem-free: the matching happened in usage
 * analysis. Same guards as "unused" (reference-analysed, not required by
 * another direct dependency, not allowlisted), so it is the unused verdict
 * scoped to this PR, with the removed lines as evidence.
 */
const removedLastUsageRule: PolicyRule = {
  id: "removed-last-usage",
  evaluate(d, context) {
    if (context.input.mode !== "pull-request") return undefined;
    const removed = context.removedInPrByDependency.get(key(d)) ?? [];
    if (removed.length === 0) return undefined;
    if (!hasNoUsageEvidence(d, context)) return undefined;
    if (!context.referenceAnalysedEcosystems.has(d.project.ecosystem)) return undefined;
    if (context.requiredByOtherDirect.has(key(d))) return undefined;
    const shown = [...removed]
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
      .slice(0, MAX_REMOVED_EVIDENCE);
    const files = [...new Set(shown.map((u) => u.file))];
    return {
      kind: "unused",
      rule: "removed-last-usage",
      dependency: d.name,
      summary: `${d.name} is no longer used after this pull request`,
      recommendation: `This pull request removes the last use of ${d.name}. Remove it from ${d.declaredIn}.`,
      evidence: [
        ...shown.map((u) => ({
          kind: "usage-removed-in-pr",
          statement: `this pull request removes a use of ${d.name}`,
          file: u.file,
          line: u.line,
        })),
        noImportsEvidence(d),
        {
          kind: "no-reference-found",
          statement: `no script, bin or config reference to ${d.name} found`,
        },
        {
          kind: "not-allowlisted",
          statement: `${d.name} is not on the dev-tooling allowlist`,
        },
      ],
      confidence: "high",
      limitations:
        removed.length > shown.length
          ? [`${removed.length - shown.length} more removed use(s) are not listed.`]
          : [],
      affectedFiles: [d.declaredIn, ...files.filter((f) => f !== d.declaredIn)],
    };
  },
};

/**
 * "unverified-no-imports": no imports found but the evidence is incomplete
 * (scripts/config not checked, or another direct dep depends on it). Info
 * only, never a removal verdict. Its own rule id so reporters can filter it.
 */
const unverifiedNoImportsRule: PolicyRule = {
  id: "unverified-no-imports",
  evaluate(d, context) {
    if (!hasNoUsageEvidence(d, context)) return undefined;
    const base = {
      kind: "info" as const,
      rule: "unverified-no-imports",
      dependency: d.name,
      confidence: "low" as const,
      affectedFiles: [d.declaredIn],
    };
    const requiredBy = context.requiredByOtherDirect.get(key(d));
    if (requiredBy) {
      return {
        ...base,
        summary: `${d.name} is not imported directly, but ${requiredBy} depends on it`,
        recommendation: `Manual review recommended: ${d.name} may be a peer dependency of ${requiredBy}.`,
        evidence: [
          noImportsEvidence(d),
          {
            kind: "required-by-direct-dependency",
            statement: `${requiredBy} depends on ${d.name}`,
          },
        ],
        limitations: ["Peer dependency relationships are not analysed yet (#11)."],
      };
    }
    if (context.referenceAnalysedEcosystems.has(d.project.ecosystem)) return undefined;
    return {
      ...base,
      summary: `no imports of ${d.name} found; scripts and config were not checked`,
      recommendation: `Manual review recommended: check whether ${d.name} is used by package scripts, CLI invocations or config files.`,
      evidence: [noImportsEvidence(d)],
      limitations: ["Script, bin and config-file references were not analysed for this ecosystem."],
    };
  },
};

const shouldBeDevRule: PolicyRule = {
  id: "should-be-dev",
  evaluate(d, context) {
    if (d.kind !== "runtime") return undefined;
    const usages = usagesOf(d, context);
    const imports = usages.filter((u) => (u.via ?? "import") === "import");
    if (imports.length === 0) return undefined;
    if (!imports.every((u) => isNonShippedPath(u.file))) return undefined;
    const sample = imports.slice(0, 5);
    return {
      kind: "should-be-dev",
      rule: "should-be-dev",
      dependency: d.name,
      summary: `${d.name} is only imported from tests, build or config code`,
      recommendation: `Move ${d.name} to development dependencies.`,
      evidence: [
        {
          kind: "declared-in",
          statement: `declared as a runtime dependency in ${d.declaredIn}`,
          ...atDeclaration(d),
        },
        ...sample.map((u) => ({
          kind: "non-shipped-import",
          statement: `imported from non-shipped file ${u.file}`,
          file: u.file,
          line: u.line,
        })),
      ],
      confidence: "medium",
      limitations: [
        "Shipped vs non-shipped code is inferred from paths; a build that ships these files would need it at runtime.",
      ],
      affectedFiles: [d.declaredIn],
    };
  },
};

const typeOnlyRule: PolicyRule = {
  id: "type-only",
  evaluate(d, context) {
    if (d.kind !== "runtime") return undefined;
    if (!context.typeStrippingEcosystems.has(d.project.ecosystem)) return undefined;
    if (d.name.startsWith("@types/")) return undefined;
    const usages = usagesOf(d, context);
    if (usages.length === 0) return undefined;
    if (!usages.every((u) => u.typeOnly === true && (u.via ?? "import") === "import")) {
      return undefined;
    }
    return {
      kind: "type-only",
      rule: "type-only",
      dependency: d.name,
      summary: `${d.name} is only used in type positions`,
      recommendation: `Move ${d.name} to development dependencies; types are removed at build time.`,
      evidence: usages.slice(0, 5).map((u) => ({
        kind: "type-only-import",
        statement: `type-only import of ${d.name}`,
        file: u.file,
        line: u.line,
      })),
      confidence: "medium",
      limitations: [
        `If this package publishes type declarations that reference ${d.name}, its consumers need it as a dependency.`,
      ],
      affectedFiles: [d.declaredIn],
    };
  },
};

/** Registered rules, in evaluation order. First finding per dependency wins. */
export const DEFAULT_RULES: readonly PolicyRule[] = [
  removedLastUsageRule,
  unusedRule,
  unverifiedNoImportsRule,
  typeOnlyRule,
  shouldBeDevRule,
];

function applyDowngrade(finding: Finding, cap: Confidence | undefined): Finding {
  if (!cap || RANK[finding.confidence] <= RANK[cap]) return finding;
  return { ...finding, confidence: cap };
}

function buildContext(input: RecommendationInput, config: PolicyConfig): PolicyContext {
  const usagesByDependency = new Map<string, Usage[]>();
  const ecosystemByName = new Map<string, Set<string>>();
  for (const d of input.dependencies) {
    const set = ecosystemByName.get(d.name) ?? new Set<string>();
    set.add(d.project.ecosystem);
    ecosystemByName.set(d.name, set);
  }
  // A removed line is evidence of a removal, never usage at head (#101).
  const removedInPrByDependency = new Map<string, Usage[]>();
  for (const u of input.usages) {
    const target = u.removedInPr === true ? removedInPrByDependency : usagesByDependency;
    for (const ecosystem of ecosystemByName.get(u.dependency) ?? []) {
      const k = `${ecosystem}\0${u.dependency}`;
      const list = target.get(k) ?? [];
      list.push(u);
      target.set(k, list);
    }
  }

  // A direct dependency reachable from another direct dependency's closure.
  const requiredByOtherDirect = new Map<string, string>();
  for (const graph of input.graphs) {
    const ecosystem = graph.project.ecosystem;
    const directs = new Set(
      input.dependencies
        .filter((d) => d.project.ecosystem === ecosystem && d.project.path === graph.project.path)
        .map((d) => d.name),
    );
    for (const [direct, closure] of Object.entries(graph.transitiveClosure).sort()) {
      if (!directs.has(direct)) continue;
      for (const name of closure) {
        const k = `${ecosystem}\0${name}`;
        if (name !== direct && directs.has(name) && !requiredByOtherDirect.has(k)) {
          requiredByOtherDirect.set(k, direct);
        }
      }
    }
  }

  return {
    input,
    usagesByDependency,
    removedInPrByDependency,
    allowlists: mergeAllowlists(DEFAULT_TOOLING_ALLOWLIST, config.allowlist),
    typeStrippingEcosystems: new Set(config.typeStrippingEcosystems ?? ["javascript-typescript"]),
    referenceAnalysedEcosystems: input.referenceAnalysedEcosystems,
    requiredByOtherDirect,
  };
}

/** Build the default policy with optional config. */
export function createDefaultPolicy(
  config: PolicyConfig = {},
  rules: readonly PolicyRule[] = DEFAULT_RULES,
): RecommendationPolicy {
  const disabled = new Set(config.disabled ?? []);
  const active = rules.filter((rule) => !disabled.has(rule.id));
  return (input) => {
    const context = buildContext(input, config);
    // PR scan (#128): only dependencies the PR added or changed get findings.
    // Removed dependencies are no longer declared, so they get none here.
    // A dependency whose use the PR removed counts as touched too (#101).
    const touched =
      input.mode === "pull-request"
        ? new Set([
            ...(input.pullRequestChanges ?? [])
              .filter((change) => change.change !== "removed")
              .map((change) => `${change.ecosystem}\0${change.name}`),
            ...context.removedInPrByDependency.keys(),
          ])
        : undefined;
    const findings: Finding[] = [];
    for (const dependency of input.dependencies) {
      if (touched && !touched.has(key(dependency))) continue;
      for (const rule of active) {
        const finding = rule.evaluate(dependency, context);
        if (finding) {
          findings.push(applyDowngrade(finding, config.downgrade?.[rule.id]));
          break;
        }
      }
    }
    return findings;
  };
}

/** The default policy with default config. */
export const defaultPolicy: RecommendationPolicy = createDefaultPolicy();

/** Machine-readable counts for check-run summaries (#97). */
export interface FindingSummary {
  total: number;
  byKind: Record<string, number>;
  byRule: Record<string, number>;
  byConfidence: Record<Confidence, number>;
}

export function summariseFindings(findings: readonly Finding[]): FindingSummary {
  const summary: FindingSummary = {
    total: findings.length,
    byKind: {},
    byRule: {},
    byConfidence: { high: 0, medium: 0, low: 0 },
  };
  for (const f of findings) {
    summary.byKind[f.kind] = (summary.byKind[f.kind] ?? 0) + 1;
    if (f.rule) summary.byRule[f.rule] = (summary.byRule[f.rule] ?? 0) + 1;
    summary.byConfidence[f.confidence] += 1;
  }
  return summary;
}
