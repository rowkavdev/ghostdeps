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
}

/** The transitive graph for one project, built from lockfiles only. */
export interface DependencyGraph {
  project: ProjectRef;
  nodes: GraphNode[];
  /** Direct dependency name -> full transitive closure (names). */
  transitiveClosure: Record<string, string[]>;
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
  exists(path: string): Promise<boolean>;
}

/** What network access, if any, an analysis run permits. Adapters never fetch directly. */
export interface NetworkPolicy {
  mode: "offline" | "metadata-only";
}

/** The full result of analysing a repository. Schema-versioned for JSON output. */
export interface AnalysisResult {
  schemaVersion: 1;
  projects: ProjectRef[];
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
