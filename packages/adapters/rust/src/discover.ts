/**
 * Crate discovery shared by detection and dependency listing: every
 * non-excluded Cargo.toml, parsed once, with each crate's workspace root.
 */
import { hasExcludedSegment, type AdapterContext, type ProjectRef } from "@ghostdeps/core";
import {
  LOCKFILE,
  MANIFEST,
  RUST_ECOSYSTEM,
  hasPackage,
  readManifest,
  resolveWorkspaces,
  type CargoManifest,
} from "./cargo-toml.js";
import { compareStrings, joinPath, relativePath } from "./paths.js";

export interface Crate {
  manifest: CargoManifest;
  project: ProjectRef;
  workspaceRoot?: CargoManifest;
  /** Repo-relative Cargo.lock that governs this crate, if present. */
  lockfile?: string;
}

export interface Discovery {
  files: string[];
  manifests: CargoManifest[];
  crates: Crate[];
}

export function isManifestPath(file: string): boolean {
  return file === MANIFEST || file.endsWith(`/${MANIFEST}`);
}

export async function discoverCrates(context: AdapterContext): Promise<Discovery> {
  const files = (await context.repository.listFiles()).filter((f) => !hasExcludedSegment(f));
  const fileSet = new Set(files);
  const manifests: CargoManifest[] = [];
  for (const path of files
    .filter(isManifestPath)
    .sort((a, b) => a.length - b.length || compareStrings(a, b))) {
    context.signal?.throwIfAborted();
    manifests.push(await readManifest(context.repository, path));
  }
  const byRoot = new Map(manifests.map((m) => [m.root, m]));
  const workspaces = resolveWorkspaces(manifests, byRoot);
  const crates: Crate[] = [];
  for (const manifest of manifests) {
    if (!hasPackage(manifest)) continue;
    const workspaceRoot = workspaces.get(manifest.root);
    // The lockfile lives next to the workspace root (or the crate itself).
    const lockDir = workspaceRoot?.root ?? manifest.root;
    const lockPath = joinPath(lockDir, LOCKFILE);
    const lockfile = fileSet.has(lockPath) ? lockPath : undefined;
    const project: ProjectRef = {
      path: manifest.root,
      ecosystem: RUST_ECOSYSTEM,
      packageManagers: [
        lockfile !== undefined
          ? { name: "cargo", lockfile: relativePath(manifest.root, lockfile) }
          : { name: "cargo" },
      ],
    };
    const crate: Crate = { manifest, project };
    if (workspaceRoot !== undefined) crate.workspaceRoot = workspaceRoot;
    if (lockfile !== undefined) crate.lockfile = lockfile;
    crates.push(crate);
  }
  return { files, manifests, crates };
}
