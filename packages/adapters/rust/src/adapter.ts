/**
 * The Rust (Cargo) ecosystem adapter. Built up issue by issue: #49
 * manifest parsing (with detection), #50 Cargo.lock graph and usage
 * scanning, #51 fixtures.
 */
import { adapterApiVersion } from "@ghostdeps/core";
import type {
  AdapterCapability,
  AdapterContext,
  AdapterNote,
  Dependency,
  EcosystemAdapter,
  ProjectRef,
} from "@ghostdeps/core";
import { RUST_ECOSYSTEM } from "./cargo-toml.js";
import { detectRust } from "./detect.js";
import { discoverCrates } from "./discover.js";
import { buildDependencyGraph } from "./lockfile.js";
import { parseCargoManifest } from "./manifest.js";
import { compareStrings } from "./paths.js";
import { findUsage, parseErrorLimitations } from "./usage.js";

/** Files named in the parse-error note; the rest are counted. */
const MAX_NAMED_PARSE_ERROR_FILES = 5;

/**
 * One run-level note (#291, #205) naming .rs files tree-sitter could not
 * parse cleanly. Awareness only: it never caps, and it does not claim any
 * verdict changed, because rust usage is always read as incomplete.
 */
export async function parseErrorNotes(
  context: AdapterContext,
  projects: ProjectRef[],
): Promise<AdapterNote[]> {
  const files = new Set<string>();
  for (const project of projects) {
    for (const l of await parseErrorLimitations(context, project.path)) {
      if (l.file !== undefined) files.add(l.file);
    }
  }
  if (files.size === 0) return [];
  const sorted = [...files].sort(compareStrings);
  const named = sorted.slice(0, MAX_NAMED_PARSE_ERROR_FILES).join(", ");
  const more = sorted.length - MAX_NAMED_PARSE_ERROR_FILES;
  const count = sorted.length === 1 ? "1 Rust file has" : `${sorted.length} Rust files have`;
  return [
    {
      statement: `${count} syntax errors, so crate references in them may be missed: ${named}${more > 0 ? ` and ${more} more` : ""}`,
    },
  ];
}

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
    notes: parseErrorNotes,
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
