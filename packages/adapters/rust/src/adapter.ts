/**
 * The Rust (Cargo) ecosystem adapter. Built up issue by issue: #49
 * manifest parsing (with detection), #50 Cargo.lock graph and usage
 * scanning, #51 fixtures.
 */
import { adapterApiVersion } from "@ghostdeps/core";
import type {
  AdapterCapability,
  AdapterContext,
  Dependency,
  EcosystemAdapter,
  ProjectRef,
} from "@ghostdeps/core";
import { RUST_ECOSYSTEM } from "./cargo-toml.js";
import { detectRust } from "./detect.js";
import { discoverCrates } from "./discover.js";
import { buildDependencyGraph } from "./lockfile.js";
import { parseCargoManifest } from "./manifest.js";
import { findUsage } from "./usage.js";

export function createRustAdapter(): EcosystemAdapter {
  return {
    ecosystem: RUST_ECOSYSTEM,
    apiVersion: adapterApiVersion,
    // No "referenceAnalysis": findUsage returns plain Usage[] (read as
    // incomplete), so policy never reaches an "unused" verdict from it (#121).
    capabilities: new Set<AdapterCapability>(["dependencyGraph", "usageAnalysis"]),
    detect: detectRust,
    buildDependencyGraph,
    findUsage,
    async listDirectDependencies(
      context: AdapterContext,
      projects: ProjectRef[],
    ): Promise<Dependency[]> {
      const wanted = new Set(projects.map((p) => p.path));
      const { crates } = await discoverCrates(context);
      const all: Dependency[] = [];
      for (const crate of crates) {
        if (!wanted.has(crate.project.path)) continue;
        const project = projects.find((p) => p.path === crate.project.path) ?? crate.project;
        all.push(...parseCargoManifest(crate.manifest, project, crate.workspaceRoot).dependencies);
      }
      return all;
    },
  };
}
