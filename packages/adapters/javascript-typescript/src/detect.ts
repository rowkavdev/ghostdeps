/**
 * Ecosystem detection for JavaScript/TypeScript (issue #24; ADR 0002
 * two-phase detection). Each candidate project root is scored from manifest
 * presence, JS/TS source-file counts and lockfiles. A manifest without
 * meaningful source stays below threshold and is skipped with a stated
 * reason; malformed manifests degrade confidence instead of crashing
 * (security-model rule 3).
 */
import {
  hasExcludedSegment,
  type AdapterContext,
  type DetectionResult,
  type Evidence,
  type ProjectRef,
} from "@ghostdeps/core";
import { detectPackageManagers, type PackageManagerDetection } from "./package-managers.js";
import { displayRoot, joinPath } from "./paths.js";

export const JS_ECOSYSTEM = "javascript-typescript";

/**
 * Core skips adapters below this confidence. A package.json alone never
 * crosses it; meaningful JS/TS source is required.
 */
export const DETECTION_CONFIDENCE_THRESHOLD = 0.5;

/** Lockfiles signalling a JS/TS package manager (detailed detection is #25). */
const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

const SOURCE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"] as const;

/**
 * Vendored and generated directories are never evidence of ecosystem use.
 * The shared list lives in core (issue #89).
 */
function isExcluded(path: string): boolean {
  return hasExcludedSegment(path);
}

function isSourceFile(path: string): boolean {
  // Declaration-only packages carry types, not meaningful source.
  if (path.endsWith(".d.ts")) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Repo-relative project root for a manifest path ("package.json" -> "."). */
function manifestRoot(manifestPath: string): string {
  return manifestPath === "package.json" ? "." : manifestPath.slice(0, -"/package.json".length);
}

/** The deepest root containing the file wins, so monorepo members own their source. */
function nearestRoot(file: string, rootSet: ReadonlySet<string>): string | undefined {
  let dir = file;
  for (;;) {
    const slash = dir.lastIndexOf("/");
    if (slash === -1) return rootSet.has(".") ? "." : undefined;
    dir = dir.slice(0, slash);
    if (rootSet.has(dir)) return dir;
  }
}

export async function detectJavaScriptTypeScript(
  context: AdapterContext,
): Promise<DetectionResult> {
  const { repository } = context;
  const files = (await repository.listFiles()).filter((file) => !isExcluded(file));
  const fileSet = new Set(files);
  const roots = files
    .filter((file) => file === "package.json" || file.endsWith("/package.json"))
    .map(manifestRoot)
    .sort((a, b) => a.length - b.length);

  if (roots.length === 0) {
    return { confidence: 0, projects: [], evidence: [] };
  }

  const rootSet = new Set(roots);
  const sourceCountByRoot = new Map<string, number>(roots.map((root) => [root, 0]));
  for (const file of files.filter(isSourceFile)) {
    const root = nearestRoot(file, rootSet);
    if (root !== undefined) sourceCountByRoot.set(root, (sourceCountByRoot.get(root) ?? 0) + 1);
  }

  const evidence: Evidence[] = [];
  const projects: ProjectRef[] = [];
  const pmByRoot = new Map<string, PackageManagerDetection>();
  let best = 0;

  for (const root of roots) {
    const manifestPath = joinPath(root, "package.json");
    evidence.push({
      kind: "manifest-found",
      statement: `found ${manifestPath}`,
      file: manifestPath,
    });

    let manifestReadable = true;
    try {
      JSON.parse(await repository.readFile(manifestPath));
    } catch {
      manifestReadable = false;
    }

    const sourceCount = sourceCountByRoot.get(root) ?? 0;
    let confidence: number;

    if (!manifestReadable) {
      // The ecosystem may still be present (source files exist), but the
      // manifest is untrusted input the parser cannot use.
      confidence = sourceCount > 0 ? DETECTION_CONFIDENCE_THRESHOLD : 0.2;
      evidence.push({
        kind: "manifest-malformed",
        statement: `${manifestPath} is not valid JSON; degrading confidence instead of failing`,
        file: manifestPath,
      });
    } else if (sourceCount === 0) {
      confidence = 0.3;
      evidence.push({
        kind: "no-js-ts-source",
        statement: `${manifestPath} has no meaningful JS/TS source under ${displayRoot(root)}`,
        file: manifestPath,
      });
    } else {
      confidence = 0.7;
      evidence.push({
        kind: "source-files",
        statement: `${sourceCount} JS/TS source file(s) under ${displayRoot(root)}`,
      });
      const lockfile = LOCKFILES.find((name) => fileSet.has(joinPath(root, name)));
      if (lockfile !== undefined) {
        confidence += 0.1;
        evidence.push({
          kind: "lockfile-found",
          statement: `a JS/TS lockfile is present at ${displayRoot(root)}`,
          file: joinPath(root, lockfile),
        });
      }
      const tsconfigPath = joinPath(root, "tsconfig.json");
      if (fileSet.has(tsconfigPath)) {
        confidence += 0.1;
        evidence.push({
          kind: "tsconfig-found",
          statement: `found ${tsconfigPath}`,
          file: tsconfigPath,
        });
      }
      if (sourceCount >= 5) confidence += 0.1;
      confidence = Math.min(confidence, 1);
    }

    // Package-manager detection (issue #25) runs for every root, including
    // below-threshold ones: a skipped workspace root still owns the lockfile
    // its members inherit. Conflicting signals lower confidence rather than
    // forcing a guess.
    const pm = await detectPackageManagers(repository, root, fileSet);
    pmByRoot.set(root, pm);
    if (confidence >= DETECTION_CONFIDENCE_THRESHOLD) {
      evidence.push(...pm.evidence);
      if (pm.conflict) confidence = Math.max(0, confidence - 0.1);
    }

    // Round to 2dp: float arithmetic makes 0.7+0.1+0.1+0.1 == 0.9999...
    confidence = Math.round(confidence * 100) / 100;
    best = Math.max(best, confidence);
    if (confidence >= DETECTION_CONFIDENCE_THRESHOLD) {
      projects.push({
        path: root,
        ecosystem: JS_ECOSYSTEM,
        packageManagers: pm.managers,
      });
    } else {
      evidence.push({
        kind: "project-skipped",
        statement: `skipped ${displayRoot(root)}: confidence ${confidence.toFixed(2)} is below the detection threshold ${DETECTION_CONFIDENCE_THRESHOLD}`,
      });
    }
  }

  // Workspace members without their own lockfile inherit the nearest
  // ancestor ROOT's single, unconflicted package manager (issue #25). The
  // ancestor need not be a detected project itself: a sourceless workspace
  // root still owns the lockfile its members install with.
  for (const project of projects) {
    if (project.packageManagers.length > 0) continue;
    const ancestors = roots
      .filter(
        (candidate) =>
          candidate !== project.path &&
          (candidate === "." || project.path.startsWith(`${candidate}/`)),
      )
      .sort((a, b) => b.length - a.length);
    const ancestor = ancestors[0];
    if (ancestor === undefined) continue;
    const ancestorPm = pmByRoot.get(ancestor);
    const only =
      ancestorPm !== undefined && !ancestorPm.conflict && ancestorPm.managers.length === 1
        ? ancestorPm.managers[0]
        : undefined;
    if (only !== undefined) {
      project.packageManagers.push(only);
      evidence.push({
        kind: "package-manager-inherited",
        statement: `${displayRoot(project.path)} inherits ${only.name} from ${displayRoot(ancestor)}${only.lockfile !== undefined ? ` (${only.lockfile})` : ""}`,
      });
    }
  }

  return { confidence: best, projects, evidence };
}
