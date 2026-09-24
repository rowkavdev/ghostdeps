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
  UsageAnalysisReport,
} from "@ghostdeps/core";
import { JS_ECOSYSTEM, detectJavaScriptTypeScript } from "./detect.js";
import { buildDependencyGraph } from "./lockfile/index.js";
import { parseManifest } from "./manifest.js";
import { findConfigUsages, unreadConfigs } from "./references/config.js";
import { findScriptUsages, scriptGaps } from "./references/scripts.js";
import { findUsage, usageLimitations } from "./usage/index.js";

export function createJavaScriptTypeScriptAdapter(): EcosystemAdapter {
  return {
    ecosystem: JS_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    capabilities: new Set<AdapterCapability>(["dependencyGraph", "usageAnalysis"]),
    detect: detectJavaScriptTypeScript,
    buildDependencyGraph,
    /**
     * Source imports plus script (via="script") and config/convention
     * (via="config"/"convention") references (#132). referenceAnalysisComplete
     * is true only when nothing in the dependency's project (or, for a
     * workspace member, the root) went unread: no import-scan limitation, no
     * script gap and no unread config. Anything else stays incomplete, so the
     * policy reports "manual review" rather than "unused".
     */
    async findUsage(context: AdapterContext, dependency: Dependency): Promise<UsageAnalysisReport> {
      const [imports, scripts, configs, importGaps, scriptProblems, unread] = await Promise.all([
        findUsage(context, dependency),
        findScriptUsages(context, dependency),
        findConfigUsages(context, dependency),
        usageLimitations(context, dependency.project.path),
        scriptGaps(context, dependency),
        unreadConfigs(context, dependency),
      ]);
      return {
        usages: [...imports, ...scripts, ...configs],
        referenceAnalysisComplete:
          importGaps.length === 0 && scriptProblems.length === 0 && unread.length === 0,
      };
    },
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
