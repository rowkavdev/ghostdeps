/**
 * The Python ecosystem adapter. Built up issue by issue: #42 detection,
 * #43/#44 manifest parsing, #45 lockfile graphs, #46 import mapping and
 * #47 extras.
 */
import { adapterApiVersion } from "@ghostdeps/core";
import type {
  AdapterCapability,
  AdapterContext,
  Dependency,
  EcosystemAdapter,
  ProjectRef,
} from "@ghostdeps/core";
import { PYTHON_ECOSYSTEM, detectPython } from "./detect.js";
import { parseManifests } from "./manifest.js";

export function createPythonAdapter(): EcosystemAdapter {
  return {
    ecosystem: PYTHON_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    capabilities: new Set<AdapterCapability>(),
    detect: detectPython,
    async listDirectDependencies(
      context: AdapterContext,
      projects: ProjectRef[],
    ): Promise<Dependency[]> {
      const all: Dependency[] = [];
      for (const project of projects) {
        // Malformed manifests surface as detection evidence; here they
        // yield zero dependencies, never a crash.
        const result = await parseManifests(context.repository, project);
        all.push(...result.requirements.map((requirement) => requirement.dependency));
      }
      return all;
    },
  };
}
