/**
 * Shared GhostDeps contracts. ADR 0002 is the authority; these types are
 * its executable form. Everything a finding claims must be backed by
 * evidence, a confidence level, and stated limitations.
 */

/** Where a dependency was declared. */
export type DependencyKind = "runtime" | "dev" | "peer" | "optional" | "build";

/** Confidence is computed from evidence, never asserted without it. */
export type Confidence = "high" | "medium" | "low";

/** A package manager instance detected in a project. */
export interface PackageManager {
  /** e.g. "npm", "pnpm", "yarn", "bun", "pip", "poetry", "uv", "pipenv", "cargo", "go-modules" */
  name: string;
  /** Lockfile that identified it, relative to the project root, if any. */
  lockfile?: string;
}

/** A project root inside a repository (repo root or a workspace member). */
export interface ProjectRef {
  /** Path relative to the repository root; "." for the root itself. */
  path: string;
  ecosystem: string;
  packageManagers: PackageManager[];
}

/** A declared direct dependency, normalised across ecosystems. */
export interface Dependency {
  name: string;
  /** Version constraint as declared (semver range, PEP 440 specifier, etc.). */
  constraint: string;
  kind: DependencyKind;
  /** The project that declares it. */
  project: ProjectRef;
  /** Manifest file it came from, relative to the repository root. */
  declaredIn: string;
  /**
   * 1-based line in `declaredIn` where the dependency is declared (#198).
   * Optional and additive (no adapterApiVersion bump). The engine keeps it
   * only if that line of the manifest contains the dependency name; any
   * other value is dropped, never guessed.
   */
  declaredLine?: number;
  /** Non-registry specifiers (git, file, link, workspace) recorded, never executed. */
  specifier?: { type: "registry" | "git" | "file" | "link" | "workspace"; detail?: string };
}

/** A node in the resolved dependency graph. */
export interface GraphNode {
  name: string;
  version: string;
  /** Names of this node's own dependencies (edges). */
  dependencies: string[];
  dev: boolean;
  /**
   * Where the lockfile says this package was fetched from (#174 step 3):
   * the lowercase URL origin (`scheme://host[:port]`) of its resolved
   * http(s) tarball URL, e.g. "https://registry.npmjs.org". Only from
   * explicit lockfile evidence, or a scoped registry binding that
   * unambiguously matches the package's scope; a default registry setting
   * is not evidence. Absent for git, file, link and workspace packages
   * and whenever in doubt: absent fails closed (no registry lookup, so no
   * footprint). Additive, optional.
   */
  registryOrigin?: string;
}

/** The transitive graph for one project, built from lockfiles only. */
export interface DependencyGraph {
  project: ProjectRef;
  nodes: GraphNode[];
  /** Direct dependency name -> full transitive closure (names). */
  transitiveClosure: Record<string, string[]>;
  /** Direct host -> resolved peer names from its exact lockfile instance, when recorded. */
  directPeers?: Record<string, string[]>;
  /** Direct host -> peer names declared but not resolved to an installed package. */
  unresolvedDirectPeers?: Record<string, string[]>;
  /** True when no lockfile existed and the graph is incomplete. */
  incomplete: boolean;
}

/** One observed use of a dependency, with location evidence. */
export interface Usage {
  dependency: string;
  file: string;
  line: number;
  /** Import form: static import, require, dynamic import, etc. */
  form: "static" | "require" | "dynamic" | "unknown";
  /**
   * True when the import is type-only (TS `import type`, `import()` in type
   * positions). Orthogonal to form. A dependency used only in type positions
   * is a devDependency candidate - this bit is what preserves that evidence.
   */
  typeOnly?: boolean;
  /**
   * How the dependency was referenced. Absent means "import" (source
   * import/require). "script": package.json script or bin invocation;
   * "config": a config file reference (tsconfig types, eslint/babel/jest
   * plugin lists); "convention": a framework plugin convention the adapter
   * knows. Every value counts as usage before an "unused" verdict (#121).
   */
  via?: "import" | "script" | "config" | "convention";
  /** The API surface observed, e.g. ["get", "post"] for axios.get/axios.post. */
  symbols: string[];
  /**
   * PR mode (#101): this usage is on a line the pull request removed, found
   * in AdapterContext.pullRequestSourceChanges. `file` and `line` point at
   * the base-side line. It is evidence of a removal, not usage at head:
   * policy never counts it as "used". Absent means false. Additive, so no
   * adapterApiVersion bump (same precedent as `via`, #130).
   */
  removedInPr?: boolean;
}

/** One changed line in a pull request diff. */
export interface ChangedLine {
  /** 1-based line number: base file for removed lines, head file for added lines. */
  line: number;
  text: string;
}

/**
 * Source lines a pull request removed and added in one non-dependency file
 * (#101). Built by extractDependencyChanges; passed to the engine as
 * AnalyseOptions.pullRequestSourceChanges and on to adapters, which match
 * removed lines against dependencies. Core stays ecosystem-free.
 */
export interface SourceLineChanges {
  /** Head path; the base path for a deleted file. Repository-relative. */
  path: string;
  removedLines: ChangedLine[];
  addedLines: ChangedLine[];
}

/** A piece of evidence supporting (or weakening) a finding. */
export interface Evidence {
  /** Machine-checkable kind, e.g. "import-found", "native-api-available", "interceptor-detected". */
  kind: string;
  /** Human-readable statement, e.g. "only axios.get() is used". */
  statement: string;
  file?: string;
  line?: number;
}

export type FindingKind =
  | "unused"
  | "potentially-unnecessary"
  | "duplicate-capability"
  | "maintenance-risk"
  | "footprint"
  /** Imported only from non-shipped code (tests, build, config) but declared as a runtime dependency. */
  | "should-be-dev"
  /** Every usage is type-only and the ecosystem strips types at build time. */
  | "type-only"
  | "info";

/**
 * Severity ladder for CI gating and display filtering (see
 * report/severity.ts for how core derives it).
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** A finding. If confidence cannot be established, GhostDeps says so. */
export interface Finding {
  kind: FindingKind;
  /**
   * Id of the policy rule that produced this finding (e.g. "unused",
   * "should-be-dev"), so config can disable or downgrade rules. Reporters
   * derive severity from kind + confidence, not from the rule.
   */
  rule?: string;
  dependency?: string;
  summary: string;
  recommendation: string;
  evidence: Evidence[];
  confidence: Confidence;
  /**
   * Effective severity, stamped by the engine on every emitted finding
   * (ADR-0004: severity is core's output). Consumers read it and never
   * re-derive it from `confidence`, which a display cap (#178) may have
   * lowered. Any value an adapter or policy sets is overwritten.
   */
  severity?: Severity;
  /**
   * Awareness only, no action suggested (#234). Presenters put these in an
   * awareness section that never affects a check conclusion, title, count
   * or exit code. Set only by the core rule that emits the finding: today
   * "cross-ecosystem-capability-overlap" (#55) and
   * "same-ecosystem-capability-duplicates" (#58). Absent means NOT awareness
   * (fail-closed), so a new info rule costs a clean check until core marks
   * it, and marking a rule needs arbiter sign-off. The engine strips it from
   * adapter and policy findings.
   */
  awareness?: true;
  /**
   * A non-capping run-level adapter note (#239, #205): the engine sets it
   * when it maps an adapter's note into the result, and strips it from all
   * other adapter and policy output. findingGroup() reads it as "note";
   * unmarked info findings are "incomplete" (fail-closed).
   */
  adapterNote?: true;
  /** Core-validated, source-backed fact about an exact locked package version.
   * Engine-owned, never accepted from adapters or policy. Non-capping; unlike
   * awareness it can suggest reviewing the observed status. */
  healthFact?: true;
  /** Optional typed origin of a core-produced fact. Evidence text remains
   * readable; presenters must not parse it to recover provenance. */
  source?: { kind: "registry" | "repository-host"; basis: string; url?: string };
  /** Declaring manifest identity for duplicate names across workspaces. */
  declaringManifest?: { ecosystem: string; path: string };
  /** Why this finding might be wrong; empty only when evidence is complete. */
  limitations: string[];
  /** Files likely affected by acting on the recommendation. */
  affectedFiles: string[];
}

/** Factual health signals only; never subjective judgements. */
export interface PackageHealth {
  name: string;
  deprecated?: string;
  repositoryArchived?: boolean;
  lastReleaseDate?: string;
  /** Source of each signal, e.g. "npm registry", "github". */
  sources: string[];
}

/** A native/runtime alternative for observed usage. */
export interface Alternative {
  /** What replaces it, e.g. "fetch()" or "crypto.randomUUID()". */
  nativeCapability: string;
  /** Minimum runtime version required, e.g. { "node": "18.0.0" }. */
  minimumRuntime: Record<string, string>;
  /** Usage APIs this alternative covers. */
  coveredApis: string[];
  /** Observed usage that would break the replacement. */
  incompatibilities: Evidence[];
  confidence: Confidence;
}

/** Read-only view of a repository handed to adapters. Adapters get no other I/O. */
export interface RepositoryHandle {
  /** List files relative to the repository root (after exclusion rules). */
  listFiles(): Promise<string[]>;
  /** Read a file as UTF-8 text. Throws for missing/binary-oversized files. */
  readFile(path: string): Promise<string>;
  /**
   * Optional (#113): read at most `maxBytes` source bytes from the start of
   * the file and return the decoded prefix, with any trailing partial UTF-8
   * sequence dropped. Resolve undefined where readFile would fail with
   * not-found. Core feature-detects this method and never branches on
   * adapterApiVersion; call it through readRepositoryFileHead, which falls
   * back to readFile plus a byte slice. The prefix need not end on a line.
   * The returned prefix is at most `maxBytes`, but implementations may read
   * up to max(maxBytes, 8 KiB) source bytes (the binary sniff window), so
   * callers must tolerate that much I/O: `maxBytes` is a floor on the read
   * size, not a strict cap. FsRepositoryHandle clamps maxBytes to
   * MAX_HEAD_READ_BYTES (64 KiB). Inside the engine every adapter's handle has
   * readFileHead; a file the fallback cannot read because it is over the
   * size ceiling becomes a scan-completeness note.
   */
  readFileHead?(path: string, maxBytes: number): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
}

/** What network access, if any, an analysis run permits. Adapters never fetch directly. */
export interface NetworkPolicy {
  mode: "offline" | "metadata-only";
}

/** The full result of analysing a repository. Schema-versioned for JSON output. */
/**
 * One project in the repository-wide project tree (#55). Projects come from
 * every adapter; core only relates them by path, so a Python project inside
 * a JS workspace root is one tree.
 */
export interface ProjectNode {
  /** Deterministic id: "<ecosystem>:<path>", e.g. "javascript-typescript:packages/web". */
  id: string;
  path: string;
  ecosystem: string;
  /**
   * Id of the nearest enclosing project of any ecosystem: the deepest
   * project whose path is a strict ancestor directory of this one. Ties
   * (several ecosystems at that path) go to the lowest ecosystem name.
   * Absent for top-level projects. Projects at the same path never parent
   * each other.
   */
  parent?: string;
}

/** One resolved package in the repository-wide graph (#55). */
export interface UnifiedGraphNode {
  /** "<ecosystem>:<name>@<version>". npm "debug" and PyPI "debug" never merge. */
  id: string;
  ecosystem: string;
  name: string;
  version: string;
  /** Names (same ecosystem) this package depends on, as the lockfile records them. */
  dependencies: string[];
  /** True only when every project graph that contains it marks it dev. */
  dev: boolean;
  /** Project ids (ProjectNode.id) whose graph contains this package. */
  projects: string[];
  /** Project ids that declare it directly (matched by name). */
  directIn: string[];
}

/** Per-ecosystem coverage of the emitted graph. */
export interface UnifiedGraphEcosystem {
  ecosystem: string;
  /** Same meaning as SurfaceEntry.graphs (#114). */
  graphs: GraphCompleteness;
  /** Unique packages in the full in-memory graph. */
  nodes: number;
  /** Packages emitted here; less than `nodes` when the output was capped. */
  emitted: number;
}

/**
 * The repository-wide dependency graph (#55): every project's lockfile
 * graph merged into one package index. Only the EMITTED graph is capped
 * (MAX_EMITTED_GRAPH_NODES); findings are always computed from the full
 * in-memory graphs first, so a capped graph never changes a verdict.
 */
export interface UnifiedGraph {
  nodes: UnifiedGraphNode[];
  ecosystems: UnifiedGraphEcosystem[];
  /** True when nodes were left out of the output; one info note says so. */
  truncated: boolean;
}

/**
 * Transitive impact of one direct dependency (#59), derived by the engine
 * from lockfile graphs only (ADR 0004). A fact, never a verdict: it creates
 * no finding and never changes severity, confidence or a check conclusion.
 */
export interface DependencyImpact {
  ecosystem: string;
  /** ProjectRef.path of the declaring project. */
  project: string;
  name: string;
  /** Completeness of this project's lockfile graph (#114 meanings). */
  graph: GraphCompleteness;
  /**
   * Unique packages in the dependency's closure, not counting itself.
   * `null` when unknown (no graph, no closure entry, or `limited`), never 0
   * for "unknown". A lower bound when `graph` is "partial".
   */
  transitive: number | null;
  /**
   * Closure packages no other direct dependency of the same project reaches
   * and that aren't themselves declared directly: roughly what removing it
   * would drop. Only when `graph` is "complete" and every direct dependency
   * that is a graph node has a closure entry; otherwise `null`, because
   * missing closures can overstate exclusivity.
   */
  exclusive: number | null;
  /** True when the engine's impact work budget ran out before this project. */
  limited?: true;
  /**
   * Approximate install footprint (#59 slice B): registry-reported sizes of
   * the dependency and its closure at the versions the lockfile pins. Only
   * when the caller supplied `AnalyseOptions.metadata` and it returned sizes
   * for at least one of those packages; otherwise absent (not a note, not
   * incomplete). Install size only, never bundle size (ADR 0004).
   */
  footprint?: DependencyFootprint;
}

/** See DependencyImpact.footprint. A fact, never a verdict. */
export interface DependencyFootprint {
  approximate: true;
  /** Where the sizes come from, as the provider names it, e.g. "npm unpackedSize". */
  basis: string;
  /**
   * A lower bound on install bytes (#288): summed over the sized package
   * names, each at its smallest locked version. Closures are by name, so
   * which locked version a dependency installs isn't known; a name with any
   * unsized locked version is left out.
   */
  bytes: number;
  /**
   * Sized package names out of all counted: the dependency itself plus each
   * closure member that has a locked version.
   */
  coverage: { sized: number; total: number };
}

/** One exact package version whose install size the engine asks for. */
export interface PackageVersionRef {
  name: string;
  version: string;
  /**
   * The locked package's GraphNode.registryOrigin, validated and
   * normalised by core. Absent when no node had one, it was malformed, or
   * locked nodes for this name and version disagree. Providers decide
   * which origins they may query (the GitHub App: exactly
   * PUBLIC_NPM_REGISTRY_ORIGINS, via isPublicNpmRegistryOrigin) and skip
   * the rest.
   */
  origin?: string;
}

/**
 * Caller-supplied, cached registry metadata (ADR 0004 point 5, #59 slice
 * B). Core never fetches; the GitHub App wires its cached metadata service
 * here, and the CLI offline and tests pass nothing. Adapters never see it.
 */
/** Each optional registry fact names its source. Absence means unknown, never false. */
export interface MetadataFact<T> {
  value: T;
  basis: string;
}

/** Facts about an exact public-registry package version, not a health verdict. */
export interface PackageRegistryFacts extends PackageVersionRef {
  publishedAt?: MetadataFact<string>;
  latestVersion?: MetadataFact<string>;
  deprecated?: MetadataFact<boolean>;
  /** Repository-host sourced only. The discriminator is checked at runtime; a
   * registry basis string alone cannot authenticate an archived claim. */
  repositoryArchived?: MetadataFact<boolean> & { sourceKind: "repository-host" };
}

export interface PackageMetadataProvider {
  /**
   * Registry-reported install sizes for exact versions of one ecosystem.
   * Serve from cache; never install or build anything. Leave unknown
   * packages out of `sizes`, and return `undefined` for an ecosystem with no
   * size data (e.g. Go). A throw, a timeout or a malformed answer just
   * leaves `footprint` absent for that ecosystem.
   */
  /** Optional health facts for exact versions. No provider or no fact means unknown. */
  packageFacts?(request: {
    ecosystem: string;
    packages: readonly PackageVersionRef[];
  }): Promise<readonly PackageRegistryFacts[] | undefined>;
  installSizes(request: {
    ecosystem: string;
    packages: readonly PackageVersionRef[];
  }): Promise<
    { basis: string; sizes: readonly (PackageVersionRef & { bytes: number })[] } | undefined
  >;
}

export interface AnalysisResult {
  schemaVersion: 1;
  /** Opt-in fixture-root scope audit; omitted on legacy unscoped runs (#354). */
  scanScope?: import("../engine/scanner/scope.js").ScanScope;
  projects: ProjectRef[];
  /**
   * Every detected project with its enclosing project (#55). The engine
   * always sets it; results written before it existed omit it. Additive:
   * schemaVersion stays 1.
   */
  projectTree?: ProjectNode[];
  /** Repository-wide dependency graph (#55). Additive; the engine always sets it. */
  graph?: UnifiedGraph;
  /**
   * Transitive impact per direct dependency (#59). Additive; the engine
   * always sets it (empty when there are no dependencies).
   */
  impact?: DependencyImpact[];
  dependencies: Dependency[];
  usages: Usage[];
  findings: Finding[];
  /** Languages and package managers detected, with detection evidence. */
  detected: { ecosystem: string; confidence: Confidence; evidence: Evidence[] }[];
  /** Per-ecosystem dependency surface totals. */
  surface: SurfaceEntry[];
}

/**
 * How much of an ecosystem's transitive surface the lockfile graphs cover.
 * - "none": no usable graph (no lockfile, unparseable, or the stage failed);
 *   `transitive` is 0 but the true count is unknown.
 * - "partial": some graph was built, but a project has no graph or a graph
 *   is marked incomplete; `transitive` is a lower bound.
 * - "complete": every detected project has a complete graph.
 */
export type GraphCompleteness = "none" | "partial" | "complete";

/** One ecosystem's dependency surface totals. */
export interface SurfaceEntry {
  ecosystem: string;
  direct: number;
  /** Unique node names across the ecosystem's graphs; read with `graphs`. */
  transitive: number;
  /**
   * How complete the graphs behind `transitive` are (#114). The engine
   * always sets it; results written before it existed omit it, and readers
   * must treat a missing value as unknown, never as complete.
   */
  graphs?: GraphCompleteness;
}
export { findingGroup, type FindingGroup } from "./finding-group.js";
