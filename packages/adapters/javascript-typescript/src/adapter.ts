/**
 * The JavaScript/TypeScript ecosystem adapter. Built up issue by issue:
 * #24 detection, #25 package-manager detection, #26 manifest parsing,
 * #27 lockfile graphs and #28 usage analysis (sibling lane).
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

export function createJavaScriptTypeScriptAdapter(): EcosystemAdapter {
  return {
    ecosystem: JS_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    capabilities: new Set<AdapterCapability>(),
    detect: detectJavaScriptTypeScript,
    // Issue #26 lands the package.json -> Dependency parser. Until then this
    // adapter reports no dependencies rather than guessing.
    async listDirectDependencies(
      _context: AdapterContext,
      _projects: ProjectRef[],
    ): Promise<Dependency[]> {
      return [];
    },
  };
}
