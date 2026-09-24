/**
 * The JavaScript/TypeScript ecosystem adapter. Built up issue by issue:
 * #24 detection, #25 package-manager detection, #26 manifest parsing,
 * #27 lockfile graphs and #28 usage analysis.
 */
import { adapterApiVersion } from "@ghostdeps/core";
import type {
  AdapterCapability,
  AdapterContext,
  Dependency,
  EcosystemAdapter,
  ProjectRef,
} from "@ghostdeps/core";
import { JS_ECOSYSTEM, detectJavaScriptTypeScript } from "./detect.js";
import { buildDependencyGraph } from "./lockfile/index.js";
import { parseManifest } from "./manifest.js";
import { findUsage } from "./usage/index.js";

export function createJavaScriptTypeScriptAdapter(): EcosystemAdapter {
  return {
    ecosystem: JS_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    capabilities: new Set<AdapterCapability>(["dependencyGraph", "usageAnalysis"]),
    detect: detectJavaScriptTypeScript,
    buildDependencyGraph,
    findUsage,
    async listDirectDependencies(
      context: AdapterContext,
      projects: ProjectRef[],
    ): Promise<Dependency[]> {
      const all: Dependency[] = [];
      for (const project of projects) {
        // Parse errors surface as detection evidence (manifest-malformed);
        // a broken manifest yields zero dependencies here, never a crash.
        const result = await parseManifest(context.repository, project);
        all.push(...result.dependencies);
      }
      return all;
    },
  };
}
