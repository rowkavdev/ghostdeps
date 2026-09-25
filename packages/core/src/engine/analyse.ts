/**
 * The analysis engine: the single entry point the CLI (#39) and the GitHub
 * App check reporter (#32) call. It runs ecosystem detection, executes the
 * adapters that pass the threshold, collects facts, applies recommendation
 * policy and emits one AnalysisResult.
 *
 * Rules:
 * - Only adapters whose detection passes the threshold run (ADR 0002).
 * - Missing capabilities are skipped, never assumed.
 * - Adapters run in parallel. One adapter failing or timing out becomes an
 *   "info" finding with stated limitations; it never crashes the run.
 *   In-process timeouts bound async waits only; the worker-thread tier
 *   (isolated.ts, #90) preempts synchronous work and caps heap.
 * - Output is deterministic: the same facts always produce the same result.
 * - Recommendation policy lives in core and is injected here; adapters report facts.
 */
import { adapterNoteFindings } from "./adapter-notes.js";
import { addFootprints } from "./footprint.js";
import { healthFindings } from "./health.js";
import { computeImpact, impactLimitedNote } from "./impact.js";
import { manifestMalformedNotes } from "./manifest-malformed.js";
import { type EcosystemAdapter } from "../adapter.js";
import type { DependencyChange } from "../diff/dependency-changes.js";
import { normaliseAnalysisResult } from "../report/json.js";
import { UNUSED_CONFIDENCE_CAP, capConfidence, severityOf } from "../report/severity.js";
import { buildProjectTree } from "./project-tree.js";
import { buildUnifiedGraph } from "./unified-graph.js";
import { declarationLineNote } from "./declared-lines.js";
import { crossEcosystemOverlaps } from "./capability-overlap.js";
import { boundSourceChanges } from "./source-changes.js";
import type {
  AnalysisResult,
  Dependency,
  DependencyGraph,
  GraphCompleteness,
  Finding,
  NetworkPolicy,
  PackageMetadataProvider,
  ProjectRef,
  RepositoryHandle,
  SourceLineChanges,
  Usage,
} from "../types/index.js";
import {
  adapterFailure,
  describeError,
  detectionConfidence,
  runAdapter,
  DEFAULT_DETECTION_THRESHOLD,
  type AdapterOutcome,
} from "./run-adapter.js";

export { detectionConfidence, DEFAULT_DETECTION_THRESHOLD };

/**
 * Per-adapter stage timeout. In-process it bounds async waits only:
 * synchronous CPU work inside an adapter cannot be preempted in-process,
 * and timed-out work is asked to stop via AdapterContext.signal rather
 * than killed. The worker-thread tier (isolated.ts) enforces it
 * preemptively with terminate().
 */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 60_000;

/** Maximum concurrent findUsage calls per adapter. */
export const DEFAULT_USAGE_CONCURRENCY = 8;

/** Facts collected from adapters, handed to recommendation policy. */
export interface RecommendationInput {
  dependencies: readonly Dependency[];
  usages: readonly Usage[];
  graphs: readonly DependencyGraph[];
  /** Ecosystems whose adapter had usage analysis; policy must not call deps "unused" elsewhere. */
  usageAnalysedEcosystems: ReadonlySet<string>;
  /**
   * "full": whole-repository analysis, verdicts over every dependency.
   * "pull-request": the caller supplied pullRequestChanges; policy scopes
   * findings to the dependencies those changes touch (#128).
   */
  mode: "full" | "pull-request";
  /** Present exactly when mode is "pull-request". */
  pullRequestChanges?: readonly DependencyChange[];
  /**
   * Ecosystems whose usage analysis completed and whose adapter declares
   * "referenceAnalysis" (script/config references checked). The policy only
   * emits "unused" verdicts here; elsewhere no-import deps get info at most.
   */
  referenceAnalysedEcosystems: ReadonlySet<string>;
}

/** Core-owned policy that turns facts into findings (#56 and friends plug in here). */
export type RecommendationPolicy = (input: RecommendationInput) => Finding[] | Promise<Finding[]>;

export interface AnalyseOptions {
  adapters: readonly EcosystemAdapter[];
  /** Defaults to offline. */
  network?: NetworkPolicy;
  detectionThreshold?: number;
  adapterTimeoutMs?: number;
  /** Maximum concurrent findUsage calls per adapter. */
  usageConcurrency?: number;
  /** Omit to emit facts only (no recommendation findings). */
  recommend?: RecommendationPolicy;
  /**
   * Dependency changes in the pull request under analysis (#128). Omit for a
   * full scan. The GitHub App builds them from the PR diff: parseUnifiedDiff,
   * listDirectDependencies over base/head manifests, then
   * extractDependencyChanges (#31, wired in #115). When present, policy runs
   * in "pull-request" mode and scopes findings to touched dependencies.
   * Added/changed dependencies the adapters could not account for become
   * info findings. Source-only PRs (#101) pass an empty array; policy
   * support for last-import-removal lands with #101.
   * Versioned with @ghostdeps/core, not the adapter contract.
   */
  pullRequestChanges?: readonly DependencyChange[];
  /**
   * Set when the repository handle could not see every file (scan truncated
   * or paths skipped). Then no ecosystem counts as reference-analysed, so the
   * policy cannot return an "unused" verdict, and core caps "unused" and
   * "potentially-unnecessary" findings at medium with a limitation saying
   * why. Implied when scanCompleteness is non-empty.
   */
  scanIncomplete?: boolean;
  /**
   * Info findings describing where the scan was incomplete, from
   * scanCompletenessFindings(scan). Core appends them to the result and
   * treats a non-empty list as scanIncomplete. analyseDirectory passes both
   * from its scan; the GitHub App passes both from its tarball scan. Callers
   * never post-process the result themselves (ADR 0004, #154).
   */
  scanCompleteness?: readonly Finding[];
  /**
   * PR mode (#101): removed and added source lines from
   * extractDependencyChanges' `sourceLineChanges`. A separate field from
   * pullRequestChanges on purpose: core only bounds it (limits.ts
   * PR_SOURCE_CHANGE_LIMITS) and forwards it to adapters as
   * AdapterContext.pullRequestSourceChanges. Adapters match removed lines
   * to dependencies and report `Usage.removedInPr`; the policy stays
   * ecosystem-free. Ignored unless pullRequestChanges is also set.
   */
  pullRequestSourceChanges?: readonly SourceLineChanges[];
  /**
   * Cached registry metadata for impact footprints (#59 slice B, ADR 0004
   * point 5). Omit (the CLI offline, tests) and `impact[].footprint` is
   * absent; that is not a note and not incomplete. Core only reads sizes
   * for locked versions through it; adapters never see it.
   */
  metadata?: PackageMetadataProvider;
}

/** Finding kinds whose claim ("not needed") can be wrong when files were not scanned. */
const ABSENCE_KINDS: ReadonlySet<Finding["kind"]> = new Set(["unused", "potentially-unnecessary"]);

const INCOMPLETE_SCAN_LIMITATION =
  "The repository scan was incomplete; this dependency may be used in files that were not analysed.";

/**
 * Info findings for PR dependency changes the analysis could not cover:
 * an added/changed dependency in an ecosystem nobody analysed, or one the
 * adapter did not list from that manifest. Never silently dropped.
 */
export function pullRequestCoverageFindings(
  changes: readonly DependencyChange[],
  dependencies: readonly Dependency[],
  detectedEcosystems: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const change of changes) {
    if (change.change === "removed") continue;
    const evidence = [
      {
        kind: "pr-dependency-change",
        statement: `${change.change} ${change.name} in ${change.manifest}`,
        file: change.manifest,
      },
    ];
    if (!detectedEcosystems.has(change.ecosystem)) {
      findings.push({
        kind: "info",
        dependency: change.name,
        summary: `${change.name} was ${change.change} in this PR but ${change.ecosystem} was not analysed`,
        recommendation: "Manual review recommended for this dependency change.",
        evidence,
        confidence: "high",
        limitations: [`No adapter analysed ${change.ecosystem} in this repository.`],
        affectedFiles: [change.manifest],
      });
      continue;
    }
    const listed = dependencies.some(
      (d) =>
        d.name === change.name &&
        d.project.ecosystem === change.ecosystem &&
        d.declaredIn === change.manifest,
    );
    if (!listed) {
      findings.push({
        kind: "info",
        dependency: change.name,
        summary: `${change.name} was ${change.change} in this PR but was not found in the analysed dependencies of ${change.manifest}`,
        recommendation: "Manual review recommended for this dependency change.",
        evidence,
        confidence: "medium",
        limitations: ["The adapter did not list this dependency, so its usage was not analysed."],
        affectedFiles: [change.manifest],
      });
    }
  }
  return findings;
}

/**
 * True when a value is plain JSON data: null, booleans, strings, finite
 * numbers, arrays and plain objects, nested at most `depth` levels. The
 * JSON reporter (renderJsonReport) throws on anything else (#98), so
 * findings are checked here before they reach it: one bad finding must not
 * abort the whole analysis. The canonical sort itself never throws (#102).
 */
function isPlainData(value: unknown, depth = 32): boolean {
  if (depth < 0) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth - 1));
  // Sets are accepted because the reporter's canonical() serialises them as arrays.
  if (value instanceof Set) return [...value].every((item) => isPlainData(item, depth - 1));
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every(
      (item) => item === undefined || isPlainData(item, depth - 1),
    );
  }
  return false;
}

/**
 * Classify how far an ecosystem's graphs cover its detected projects (#114).
 * An empty graph marked incomplete (no lockfile, or one that could not be
 * parsed) carries no transitive evidence: if every graph is like that the
 * surface is "none". Next to a usable graph it still makes the total partial.
 */
function graphCompleteness(
  projects: readonly ProjectRef[],
  graphs: readonly DependencyGraph[],
): GraphCompleteness {
  const usable = graphs.filter((g) => !(g.incomplete && g.nodes.length === 0));
  if (usable.length === 0) return "none";
  if (graphs.some((g) => g.incomplete)) return "partial";
  const covered = new Set(graphs.map((g) => `${g.project.path}\0${g.project.ecosystem}`));
  const allCovered = projects.every((p) => covered.has(`${p.path}\0${p.ecosystem}`));
  return allCovered ? "complete" : "partial";
}

/**
 * Turn per-adapter outcomes (however they were produced - in-process or in
 * workers) into one AnalysisResult: merge facts, apply recommendation
 * policy, normalise ordering. Shared by analyse.ts and isolated.ts.
 */
export async function assembleAnalysisResult(
  outcomes: readonly AdapterOutcome[],
  recommend?: RecommendationPolicy,
  pullRequestChanges?: readonly DependencyChange[],
  context: {
    scanIncomplete?: boolean;
    scanCompleteness?: readonly Finding[];
    /** Engine notes (e.g. capped PR source changes) appended as findings. */
    notes?: readonly Finding[];
    /** Emitted unified-graph cap (#55). Default MAX_EMITTED_GRAPH_NODES. */
    maxGraphNodes?: number;
    /** See AnalyseOptions.metadata. */
    metadata?: PackageMetadataProvider;
  } = {},
): Promise<AnalysisResult> {
  // Caller notes plus notes adapters raised while running (#113).
  // plus unparsed manifests adapters reported (#269, engine-owned mapping).
  const scanNotes = [
    ...(context.scanCompleteness ?? []),
    ...outcomes.flatMap((outcome) => outcome.scanCompleteness ?? []),
    ...manifestMalformedNotes(
      outcomes.flatMap((outcome) =>
        outcome.detected
          ? [{ ecosystem: outcome.ecosystem, evidence: outcome.detected.evidence }]
          : [],
      ),
    ),
  ];
  const scanIncomplete = context.scanIncomplete === true || scanNotes.length > 0;
  const projects = new Map<string, ProjectRef>();
  const dependencies: Dependency[] = [];
  const usages: Usage[] = [];
  const graphs: DependencyGraph[] = [];
  const findings: Finding[] = [];
  const detected: AnalysisResult["detected"] = [];
  const surface: AnalysisResult["surface"] = [];
  const usageAnalysedEcosystems = new Set<string>();
  const referenceAnalysedEcosystems = new Set<string>();

  findings.push(...(context.notes ?? []));
  for (const outcome of outcomes) {
    findings.push(...outcome.findings);
    if (!outcome.detected) continue;
    for (const project of outcome.detected.projects) {
      projects.set(`${project.path}\0${project.ecosystem}`, project);
    }
    dependencies.push(...outcome.dependencies);
    usages.push(...outcome.usages);
    graphs.push(...outcome.graphs);
    if (outcome.usageAnalysed) usageAnalysedEcosystems.add(outcome.ecosystem);
    if (outcome.usageAnalysed && outcome.referenceAnalysed === true && !scanIncomplete) {
      referenceAnalysedEcosystems.add(outcome.ecosystem);
    }
    detected.push({
      ecosystem: outcome.ecosystem,
      confidence: outcome.detected.confidence,
      evidence: outcome.detected.evidence,
    });
    const transitive = new Set(outcome.graphs.flatMap((g) => g.nodes.map((n) => n.name)));
    surface.push({
      ecosystem: outcome.ecosystem,
      direct: new Set(outcome.dependencies.map((d) => d.name)).size,
      transitive: transitive.size,
      graphs: graphCompleteness(outcome.detected.projects, outcome.graphs),
    });
  }

  if (pullRequestChanges) {
    findings.push(
      ...pullRequestCoverageFindings(
        pullRequestChanges,
        dependencies,
        new Set(detected.map((d) => d.ecosystem)),
      ),
    );
  }

  if (recommend) {
    try {
      const input: RecommendationInput = {
        dependencies,
        usages,
        graphs,
        usageAnalysedEcosystems,
        referenceAnalysedEcosystems,
        mode: pullRequestChanges ? "pull-request" : "full",
      };
      if (pullRequestChanges) input.pullRequestChanges = pullRequestChanges;
      const proposed = await recommend(input);
      const rejected = proposed.filter((finding) => !isPlainData(finding));
      findings.push(...proposed.filter((finding) => isPlainData(finding)));
      if (rejected.length > 0) {
        findings.push({
          kind: "info",
          summary: `recommendation policy returned ${rejected.length} finding(s) that are not plain data`,
          recommendation: "Manual review recommended; those findings were dropped.",
          evidence: [{ kind: "policy-error", statement: "non-plain finding rejected" }],
          confidence: "low",
          limitations: ["Some recommendations are missing from this result."],
          affectedFiles: [],
        });
      }
    } catch (error) {
      findings.push({
        kind: "info",
        summary: `recommendation policy ${describeError(error)}`,
        recommendation: "Manual review recommended; no recommendations were produced.",
        evidence: [{ kind: "policy-error", statement: "recommendation stage failed" }],
        confidence: "low",
        limitations: ["Findings other than facts and adapter notes are missing."],
        affectedFiles: [],
      });
    }
  }

  if (scanIncomplete) {
    // An incomplete scan must never yield a confident "not needed" claim,
    // whoever produced the finding: cap at medium and say why on each one.
    for (let i = 0; i < findings.length; i++) {
      const finding = findings[i]!;
      if (!ABSENCE_KINDS.has(finding.kind)) continue;
      findings[i] = {
        ...finding,
        confidence: finding.confidence === "high" ? "medium" : finding.confidence,
        limitations: [...finding.limitations, INCOMPLETE_SCAN_LIMITATION],
      };
    }
    findings.push(...scanNotes);
    // One run-level statement covering every verdict, including hygiene
    // verdicts (should-be-dev, type-only) that carry no per-finding note.
    findings.push({
      kind: "info",
      summary: "all verdicts in this result were computed from a partial repository scan",
      recommendation:
        "Treat every recommendation here, including should-be-dev and type-only, as provisional until a complete scan confirms it.",
      evidence: [
        { kind: "scan-incomplete", statement: "the repository scan did not cover every file" },
      ],
      confidence: "high",
      limitations: [
        "Files outside the scan may use dependencies, import them from shipped code, or use them as values.",
      ],
      affectedFiles: [],
    });
  }

  // Unified graph (#55), built after the policy has seen the full graphs:
  // the emission cap trims the output only and never changes a verdict.
  const unified = buildUnifiedGraph(graphs, dependencies, surface, context.maxGraphNodes);

  // Severity is core's output (ADR-0004). Stamp it on every finding BEFORE
  // the confidence cap below, so the cap limits only the displayed
  // confidence and severity keeps the computed value (#188). Whatever an
  // adapter or policy put in `severity` is overwritten.
  // `awareness` (#234) and `adapterNote` (#239) are core's call, made by
  // the rule or engine step that emits the finding. Adapters and policies
  // can't set them: strip them here (fail-closed).
  for (let i = 0; i < findings.length; i++) {
    const finding: Finding = { ...findings[i]! };
    delete finding.awareness;
    delete finding.adapterNote;
    findings[i] = { ...finding, severity: severityOf(finding) };
  }

  // Metadata is fetched only through the caller's bounded provider, after the
  // policy, so these factual observations cannot change removal verdicts.
  // PR mode reports only newly added/changed dependencies.
  const healthDependencies = pullRequestChanges
    ? dependencies.filter((dependency) =>
        pullRequestChanges.some(
          (change) =>
            change.change !== "removed" &&
            change.ecosystem === dependency.project.ecosystem &&
            change.name === dependency.name &&
            change.manifest === dependency.declaredIn,
        ),
      )
    : dependencies;
  for (const finding of await healthFindings(healthDependencies, graphs, context.metadata)) {
    findings.push({ ...finding, severity: severityOf(finding) });
  }

  // Cross-ecosystem capability overlap (#55): awareness-only info findings
  // with a dependency, added after the policy so they never feed a verdict
  // and after the strip above so they keep `awareness`. In a PR, only
  // packages the PR added are reported.
  for (const finding of crossEcosystemOverlaps(dependencies, pullRequestChanges)) {
    findings.push({ ...finding, severity: severityOf(finding) });
  }

  // Adapter notes (#205): non-capping, added after the policy and the strip
  // above, like the overlap notes. Engine-mapped markers decide the group:
  // capability notes are awareness, run-level notes are "note".
  for (const finding of adapterNoteFindings(
    outcomes
      .filter((outcome) => outcome.detected !== undefined)
      .map((outcome) => ({
        ecosystem: outcome.ecosystem,
        notes: outcome.adapterNotes,
        dependencies: outcome.dependencies,
      })),
  )) {
    findings.push({ ...finding, severity: severityOf(finding) });
  }

  // Shipping gate (#178): until the corpus check proves recall, no unused
  // verdict claims more than UNUSED_CONFIDENCE_CAP, whoever produced it.
  let cappedUnused = 0;
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    if (finding.kind !== "unused") continue;
    const capped = capConfidence(finding.confidence, UNUSED_CONFIDENCE_CAP);
    if (capped === finding.confidence) continue;
    findings[i] = { ...finding, confidence: capped };
    cappedUnused++;
  }
  if (cappedUnused > 0) {
    findings.push({
      kind: "info",
      rule: "unused-confidence-capped",
      summary: "unused confidence capped pending corpus validation",
      recommendation:
        "Unused findings are reported at medium confidence at most until the pinned corpus check has stayed green; review before removing.",
      evidence: [
        {
          kind: "unused-confidence-capped",
          statement: `${cappedUnused} unused finding(s) capped at ${UNUSED_CONFIDENCE_CAP} confidence`,
        },
      ],
      confidence: "high",
      severity: "info",
      limitations: [],
      affectedFiles: [],
    });
  }

  // Declaration-anchored findings without a verified line (#198): one note.
  // Transitive impact (#59): engine-derived facts from the full graphs,
  // never a verdict. A budget cut adds one non-capping "note".
  const computed = computeImpact(graphs, dependencies);
  const { limitedProjects, limitedDependencies } = computed;
  const impact = await addFootprints(computed.impact, graphs, context.metadata);
  if (limitedProjects > 0) {
    const note = impactLimitedNote(limitedProjects, limitedDependencies);
    findings.push({ ...note, severity: severityOf(note) });
  }

  const lineNote = declarationLineNote(findings);
  if (lineNote) findings.push({ ...lineNote, severity: severityOf(lineNote) });

  // One canonical ordering for the engine and the JSON reporter (#71).
  return normaliseAnalysisResult({
    schemaVersion: 1,
    projects: [...projects.values()],
    projectTree: buildProjectTree([...projects.values()]),
    graph: unified,
    impact,
    dependencies,
    usages,
    findings,
    detected,
    surface,
  });
}

/** Analyse a repository through the given adapters and return one AnalysisResult. */
export async function analyseRepository(
  repository: RepositoryHandle,
  options: AnalyseOptions,
): Promise<AnalysisResult> {
  const network = options.network ?? { mode: "offline" };
  const threshold = options.detectionThreshold ?? DEFAULT_DETECTION_THRESHOLD;
  const timeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  const usageConcurrency = options.usageConcurrency ?? DEFAULT_USAGE_CONCURRENCY;
  const sourceChanges = boundPullRequestSourceChanges(options);

  // One set per run: each unsniffed file is noted once, capped run-wide.
  const unsniffed = new Set<string>();
  const outcomes = await Promise.all(
    options.adapters.map((adapter) =>
      runAdapter(
        adapter,
        repository,
        network,
        threshold,
        timeoutMs,
        usageConcurrency,
        undefined,
        sourceChanges.changes,
        unsniffed,
      ).catch((error: unknown): AdapterOutcome => ({
        ecosystem: adapter.ecosystem,
        dependencies: [],
        usages: [],
        graphs: [],
        usageAnalysed: false,
        findings: [adapterFailure(adapter, "run", error)],
      })),
    ),
  );

  return assembleAnalysisResult(outcomes, options.recommend, options.pullRequestChanges, {
    scanIncomplete: options.scanIncomplete === true,
    scanCompleteness: options.scanCompleteness ?? [],
    notes: sourceChanges.findings,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/**
 * Bound the PR source-change payload once per run (#101). Undefined
 * changes on a full scan, so adapters never see PR data outside PR mode.
 */
export function boundPullRequestSourceChanges(options: {
  pullRequestChanges?: readonly DependencyChange[];
  pullRequestSourceChanges?: readonly SourceLineChanges[];
}): { changes?: SourceLineChanges[]; findings: Finding[] } {
  if (!options.pullRequestChanges || !options.pullRequestSourceChanges) return { findings: [] };
  return boundSourceChanges(options.pullRequestSourceChanges);
}
