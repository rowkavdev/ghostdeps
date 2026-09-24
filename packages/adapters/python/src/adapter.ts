/**
 * The Python ecosystem adapter. Built up issue by issue: #42 detection,
 * #43/#44 manifest parsing, #45 lockfile graphs, #46 import mapping and
 * #47 extras. Until parsing lands, listDirectDependencies reports none.
 */
import { adapterApiVersion } from "@ghostdeps/core";
import type { AdapterCapability, Dependency, EcosystemAdapter } from "@ghostdeps/core";
import { PYTHON_ECOSYSTEM, detectPython } from "./detect.js";

export function createPythonAdapter(): EcosystemAdapter {
  return {
    ecosystem: PYTHON_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    capabilities: new Set<AdapterCapability>(),
    detect: detectPython,
    listDirectDependencies(): Promise<Dependency[]> {
      return Promise.resolve([]);
    },
  };
}
