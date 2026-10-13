/**
 * Ecosystem detection for JavaScript/TypeScript (issue #24; ADR 0002
 * two-phase detection). Each candidate project root is scored from manifest
 * presence, JS/TS source-file counts and lockfiles. A manifest without
 * meaningful source stays below threshold and is skipped with a stated
 * reason; malformed manifests degrade confidence instead of crashing
 * (security-model rule 3).
 */
import {
  MAX_FILE_READ_BYTES,
  hasExcludedSegment,
  type AdapterContext,
  type DetectionResult,
  type Evidence,
  type ProjectRef,
} from "@ghostdeps/core";
import { detectPackageManagers, type PackageManagerDetection } from "./package-managers.js";
import { displayRoot, joinPath } from "./paths.js";
import { extractScriptBlocks } from "./usage/embedded.js";

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

/**
 * Components scanned for embedded script, like find-usage. Only a component with a
 * non-empty script block (or Astro frontmatter) counts as source; HTML pages and
 * components with no script stay out, so a content-only package is not promoted.
 * A component that cannot be classified (read limit, size ceiling, unreadable, or more
 * script blocks than the extractor keeps) is never reported as "no source": the root is not
 * promoted, and detection returns a limitation that core records as a run note.
 */
const COMPONENT_EXTENSIONS = [".vue", ".svelte", ".astro"] as const;

/** Detection evidence kind for components that could not be classified. Core maps it to an incomplete-scan note. */
export const COMPONENT_UNVERIFIED_EVIDENCE = "component-source-unverified";

/** Most component files read for one project root. */
export const MAX_DETECT_COMPONENT_READS_PER_ROOT = 1_000;

/** Most component files read by one detection run across all roots. */
export const MAX_DETECT_COMPONENT_READS = 10_000;

/** Size ceiling for a component read during detection, same as the usage scan. */
const MAX_COMPONENT_BYTES = Math.min(1_000_000, MAX_FILE_READ_BYTES);

function isComponentFile(path: string): boolean {
  const lower = path.toLowerCase();
  return COMPONENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** TypeScript declaration files for each module kind. */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

function isSourceFile(path: string): boolean {
  // Declaration-only packages carry types, not meaningful source.
  if (DECLARATION_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** True when the manifest or its neighbours declare a workspace layout. */
function declaresWorkspace(manifest: unknown, files: string[], root: string): boolean {
  if (files.includes(joinPath(root, "pnpm-workspace.yaml"))) return true;
  if (typeof manifest !== "object" || manifest === null) return false;
  const workspaces = (manifest as Record<string, unknown>).workspaces;
  if (Array.isArray(workspaces)) return true;
  return (
    typeof workspaces === "object" &&
    workspaces !== null &&
    Array.isArray((workspaces as Record<string, unknown>).packages)
  );
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

  // Components with a real script block count as source. A root with five sources already
  // has the full source bonus, so its remaining components are not read. Each root has its
  // own read budget so one root's components cannot use up another's.
  const componentCountByRoot = new Map<string, number>();
  const unverifiedRoots = new Set<string>();
  const componentsByRoot = new Map<string, string[]>();
  for (const file of files.filter(isComponentFile).sort()) {
    const root = nearestRoot(file, rootSet);
    if (root === undefined) continue;
    const list = componentsByRoot.get(root);
    if (list === undefined) componentsByRoot.set(root, [file]);
    else list.push(file);
  }
  // Round-robin, one component per root per pass, so no root's components use up the
  // run-wide budget before another root is looked at. Fairness is bounded, not absolute:
  // roots still unread when the run ceiling is hit are flagged as unverified.
  let active = [...componentsByRoot.keys()].sort();
  let componentReads = 0;
  for (let index = 0; active.length > 0; index++) {
    const next: string[] = [];
    for (const root of active) {
      const components = componentsByRoot.get(root)!;
      const have = (sourceCountByRoot.get(root) ?? 0) + (componentCountByRoot.get(root) ?? 0);
      if (index >= components.length || have >= 5) continue;
      if (
        index >= MAX_DETECT_COMPONENT_READS_PER_ROOT ||
        componentReads >= MAX_DETECT_COMPONENT_READS
      ) {
        unverifiedRoots.add(root);
        continue;
      }
      componentReads++;
      next.push(root);
      const file = components[index]!;
      try {
        const text = await repository.readFile(file);
        if (Buffer.byteLength(text, "utf8") > MAX_COMPONENT_BYTES) {
          unverifiedRoots.add(root);
          continue;
        }
        const { blocks, dropped } = extractScriptBlocks(file, text);
        if (blocks.some((block) => block.code.trim() !== "")) {
          componentCountByRoot.set(root, (componentCountByRoot.get(root) ?? 0) + 1);
        }
        // Blocks past the extractor's limit were not seen, whatever the kept ones held.
        if (dropped > 0) unverifiedRoots.add(root);
      } catch {
        unverifiedRoots.add(root);
      }
    }
    active = next;
  }
  for (const [root, count] of componentCountByRoot) {
    sourceCountByRoot.set(root, (sourceCountByRoot.get(root) ?? 0) + count);
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
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(await repository.readFile(manifestPath));
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
      // A manifest-only root is normally tooling noise, but a declared
      // workspace root whose member projects have real source is a genuine
      // JS/TS project root (its own devDependencies matter).
      const memberWithSource = roots.some(
        (other) =>
          other !== root &&
          (root === "." || other.startsWith(`${root}/`)) &&
          (sourceCountByRoot.get(other) ?? 0) > 0,
      );
      if (declaresWorkspace(parsedManifest, files, root) && memberWithSource) {
        confidence = 0.6;
        evidence.push({
          kind: "workspace-root",
          statement: `${manifestPath} declares a workspace whose member projects contain JS/TS source`,
          file: manifestPath,
        });
      } else {
        confidence = 0.3;
        evidence.push({
          kind: "no-js-ts-source",
          statement: unverifiedRoots.has(root)
            ? `${manifestPath}: no JS/TS source was found under ${displayRoot(root)} in the files that could be checked; source there is not ruled out`
            : `${manifestPath} has no meaningful JS/TS source under ${displayRoot(root)}`,
          file: manifestPath,
        });
      }
    } else {
      confidence = 0.7;
      evidence.push({
        kind: "source-files",
        statement: `${sourceCount} JS/TS source file(s) under ${displayRoot(root)}${
          componentCountByRoot.has(root)
            ? ` (${componentCountByRoot.get(root)} component(s) with an embedded script)`
            : ""
        }`,
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

  // A root whose components could not all be classified is unknown, never "no source".
  // Kept as evidence whatever the confidence, so core can record it as an incomplete scan;
  // the root is not promoted.
  for (const root of [...unverifiedRoots].sort()) {
    const manifestPath = root === "." ? "package.json" : `${root}/package.json`;
    evidence.push({
      kind: COMPONENT_UNVERIFIED_EVIDENCE,
      statement: `some .vue/.svelte/.astro components under ${displayRoot(root)} could not be checked for an embedded script (read limit, size limit, unreadable or too many script blocks)`,
      file: manifestPath,
    });
  }
  return { confidence: best, projects, evidence };
}
