/**
 * The Go EcosystemAdapter (ADR 0002). Facts only; core owns policy.
 * Usage analysis (#53) covers source imports and go.mod tool directives.
 * No "referenceAnalysis": generate directives and scripts are not read.
 */
import {
  adapterApiVersion,
  type AdapterCapability,
  type AdapterContext,
  type Dependency,
  type DependencyGraph,
  type DetectionResult,
  type EcosystemAdapter,
  type ProjectRef,
} from "@ghostdeps/core";
import { detectGo, GO_ECOSYSTEM, joinPath } from "./detect.js";
import { directDependencies, moduleGraph, readGoMod } from "./manifest.js";
import { findGoUsage } from "./usage/scan.js";

const goProjects = (projects: ProjectRef[]) => projects.filter((p) => p.ecosystem === GO_ECOSYSTEM);

export function createGoAdapter(): EcosystemAdapter {
  const capabilities: ReadonlySet<AdapterCapability> = new Set<AdapterCapability>([
    "dependencyGraph",
    "usageAnalysis",
  ]);
  return {
    ecosystem: GO_ECOSYSTEM,
    capabilities,
    apiVersion: adapterApiVersion,

    async detect(context: AdapterContext): Promise<DetectionResult> {
      const result = await detectGo(context.repository);
      // Parse problems and the edgeless graph are stated as evidence, so an
      // incomplete picture is never a silent one.
      for (const project of result.projects) {
        const mod = await readGoMod(context.repository, project);
        const file = joinPath(project.path, "go.mod");
        if (!mod) {
          result.evidence.push({
            kind: "manifest-unreadable",
            statement: `${file} could not be read`,
            file,
          });
          continue;
        }
        for (const e of mod.errors) {
          result.evidence.push({
            kind: "manifest-malformed",
            statement: `${file}:${e.line}: ${e.message}; declared dependencies may be incomplete`,
            file,
            line: e.line,
          });
        }
      }
      if (result.projects.length > 0) {
        result.evidence.push({
          kind: "graph-edges-unavailable",
          statement:
            "Go module graph edges need `go mod graph`, which GhostDeps never runs; graphs list modules only",
        });
      }
      return result;
    },

    async listDirectDependencies(context, projects): Promise<Dependency[]> {
      const out: Dependency[] = [];
      for (const project of goProjects(projects)) {
        if (context.signal?.aborted) break;
        const mod = await readGoMod(context.repository, project);
        if (mod) out.push(...directDependencies(mod, project));
      }
      return out;
    },

    async buildDependencyGraph(context, projects): Promise<DependencyGraph[]> {
      const out: DependencyGraph[] = [];
      for (const project of goProjects(projects)) {
        if (context.signal?.aborted) break;
        const mod = await readGoMod(context.repository, project);
        out.push(
          mod
            ? await moduleGraph(context.repository, project, mod)
            : { project, nodes: [], transitiveClosure: {}, incomplete: true },
        );
      }
      return out;
    },

    findUsage: (context, dependency) => findGoUsage(context, dependency),
  };
}
