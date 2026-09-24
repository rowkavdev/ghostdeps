/**
 * Rust ecosystem detection (ADR 0002 two-phase detection). Each crate is
 * scored from its manifest, the .rs files it owns and a governing
 * Cargo.lock. A manifest without Rust source stays below threshold; a
 * malformed manifest degrades confidence instead of crashing.
 */
import type { AdapterContext, DetectionResult, Evidence, ProjectRef } from "@ghostdeps/core";
import { hasPackage, workspaceTable } from "./cargo-toml.js";
import { discoverCrates } from "./discover.js";
import { displayRoot } from "./paths.js";

export const DETECTION_CONFIDENCE_THRESHOLD = 0.5;

/** The deepest root containing the file wins, so workspace members own their source. */
function nearestRoot(file: string, roots: ReadonlySet<string>): string | undefined {
  let dir = file;
  for (;;) {
    const slash = dir.lastIndexOf("/");
    if (slash === -1) return roots.has(".") ? "." : undefined;
    dir = dir.slice(0, slash);
    if (roots.has(dir)) return dir;
  }
}

export async function detectRust(context: AdapterContext): Promise<DetectionResult> {
  const { files, manifests, crates } = await discoverCrates(context);
  if (manifests.length === 0) return { confidence: 0, projects: [], evidence: [] };

  const roots = new Set(manifests.map((m) => m.root));
  const sources = new Map<string, number>();
  for (const file of files) {
    if (!file.endsWith(".rs")) continue;
    const root = nearestRoot(file, roots);
    if (root !== undefined) sources.set(root, (sources.get(root) ?? 0) + 1);
  }

  const evidence: Evidence[] = [];
  const projects: ProjectRef[] = [];
  let best = 0;

  for (const manifest of manifests) {
    evidence.push({
      kind: "manifest-found",
      statement: `found ${manifest.path}`,
      file: manifest.path,
    });
    const count = sources.get(manifest.root) ?? 0;
    if (manifest.error !== undefined) {
      evidence.push(manifest.error);
      best = Math.max(best, count > 0 ? DETECTION_CONFIDENCE_THRESHOLD : 0.2);
      continue;
    }
    const workspace = workspaceTable(manifest);
    if (workspace !== undefined) {
      evidence.push({
        kind: "workspace-root",
        statement: `${manifest.path} declares a Cargo workspace`,
        file: manifest.path,
      });
    }
    if (!hasPackage(manifest)) {
      if (workspace === undefined) {
        evidence.push({
          kind: "manifest-without-package",
          statement: `${manifest.path} has neither [package] nor [workspace]; skipped`,
          file: manifest.path,
        });
      }
      continue;
    }
    const crate = crates.find((c) => c.manifest === manifest);
    if (count === 0) {
      evidence.push({
        kind: "no-source",
        statement: `${displayRoot(manifest.root)} has a Cargo.toml but no .rs files; below threshold`,
        file: manifest.path,
      });
      best = Math.max(best, 0.3);
      continue;
    }
    evidence.push({
      kind: "source-files",
      statement: `${count} .rs file${count === 1 ? "" : "s"} under ${displayRoot(manifest.root)}`,
    });
    let confidence = 0.8;
    if (crate?.lockfile !== undefined) {
      evidence.push({
        kind: "lockfile-found",
        statement: `found ${crate.lockfile}`,
        file: crate.lockfile,
      });
      confidence = 0.95;
    }
    if (crate !== undefined) projects.push(crate.project);
    best = Math.max(best, confidence);
  }
  return { confidence: best, projects, evidence };
}
