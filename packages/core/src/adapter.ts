/**
 * The ecosystem adapter contract. ADR 0002 (docs/adr/0002-adapter-interface.md)
 * is the authority; this file is its executable form.
 *
 * Adapters report facts (detection, dependencies, graphs, usage, health).
 * Recommendation policy lives in core - never in adapters.
 */
import type {
  Alternative,
  AnalysisResult,
  Dependency,
  DependencyGraph,
  Evidence,
  NetworkPolicy,
  PackageHealth,
  ProjectRef,
  RepositoryHandle,
  Usage,
} from "./types/index.js";

/** Bump the major version on any breaking change to this contract. */
export const adapterApiVersion = "0.1.0";

/** Capabilities an adapter may implement. Core degrades gracefully when absent. */
export type AdapterCapability =
  "dependencyGraph" | "usageAnalysis" | "nativeAlternatives" | "health" | "lockfileParsing";

/** Result of two-phase detection: does this ecosystem meaningfully exist here? */
export interface DetectionResult {
  /** 0..1. Core skips adapters below the shared threshold. */
  confidence: number;
  /** Project roots detected (repo root and/or workspace members). */
  projects: ProjectRef[];
  /** What was observed: manifests, source counts, lockfiles. */
  evidence: Evidence[];
}

/** The context core provides to every adapter call. */
export interface AdapterContext {
  repository: RepositoryHandle;
  network: NetworkPolicy;
}

/**
 * An ecosystem adapter. Implement only what the ecosystem supports and
 * declare exactly that in `capabilities`.
 */
export interface EcosystemAdapter {
  /** e.g. "javascript-typescript", "python", "rust", "go". */
  readonly ecosystem: string;
  readonly capabilities: ReadonlySet<AdapterCapability>;
  readonly apiVersion: string;

  /** Phase 1: decide whether this ecosystem is meaningfully present. */
  detect(context: AdapterContext): Promise<DetectionResult>;

  /** Enumerate direct dependencies for detected projects. */
  listDirectDependencies(context: AdapterContext, projects: ProjectRef[]): Promise<Dependency[]>;

  /** Build the transitive graph from lockfiles. Requires "dependencyGraph". */
  buildDependencyGraph?(
    context: AdapterContext,
    projects: ProjectRef[],
  ): Promise<DependencyGraph[]>;

  /** Find where and how a dependency is used. Requires "usageAnalysis". */
  findUsage?(context: AdapterContext, dependency: Dependency): Promise<Usage[]>;

  /** Propose native alternatives for observed usage. Requires "nativeAlternatives". */
  findNativeAlternatives?(
    context: AdapterContext,
    dependency: Dependency,
    usage: Usage[],
  ): Promise<Alternative[]>;

  /** Factual health signals via core's metadata service. Requires "health". */
  analyseHealth?(context: AdapterContext, dependency: Dependency): Promise<PackageHealth>;
}

/** What the core needs from an adapter to assemble an AnalysisResult. */
export interface AdapterRunResult {
  adapter: EcosystemAdapter;
  detection: DetectionResult;
  dependencies: Dependency[];
  usages: Usage[];
}

export type { AnalysisResult };
