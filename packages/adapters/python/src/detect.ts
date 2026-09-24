/**
 * Ecosystem detection for Python (issue #42; ADR 0002 two-phase detection).
 * Each candidate project root is scored from manifest presence, Python
 * source-file counts and lockfiles, mirroring the JS/TS adapter. A manifest
 * without meaningful source stays below threshold and is skipped with a
 * stated reason. setup.py is recorded as a manifest but never executed.
 */
import {
  hasExcludedSegment,
  type AdapterContext,
  type DetectionResult,
  type Evidence,
  type PackageManager,
  type ProjectRef,
} from "@ghostdeps/core";
import { baseName, dirName, displayRoot, joinPath } from "./paths.js";

export const PYTHON_ECOSYSTEM = "python";

/**
 * Core skips adapters below this confidence. A manifest alone never crosses
 * it; meaningful Python source is required. Same value as the JS/TS adapter.
 */
export const DETECTION_CONFIDENCE_THRESHOLD = 0.5;

/** Files that make a directory a Python project root. */
const ROOT_MANIFESTS = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"] as const;

/** requirements.txt, requirements-dev.txt, dev-requirements.txt, requirements_test.txt ... */
export function isRequirementsFile(name: string): boolean {
  return /^(?:[\w.-]*[-_.])?requirements(?:[-_.][\w.-]*)?\.(?:txt|in)$/i.test(name);
}

/** Lockfiles and the package manager each identifies. */
const LOCKFILES: readonly (readonly [string, string])[] = [
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["Pipfile.lock", "pipenv"],
  ["pdm.lock", "pdm"],
];

const SOURCE_EXTENSIONS = [".py", ".pyw"] as const;

function isSourceFile(path: string): boolean {
  // Stub-only packages (.pyi) carry types, not meaningful source.
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function isRootManifest(path: string): boolean {
  const name = baseName(path);
  return (ROOT_MANIFESTS as readonly string[]).includes(name) || isRequirementsFile(name);
}

/** requirements/base.txt, requirements/dev.in: a requirements directory layout. */
function isRequirementsDirFile(path: string): boolean {
  return baseName(dirName(path)) === "requirements" && /\.(?:txt|in)$/i.test(path);
}

/** The project root a manifest belongs to; requirements/ files belong to the parent. */
function manifestRoot(path: string): string {
  return isRequirementsDirFile(path) ? dirName(dirName(path)) : dirName(path);
}

/** A documentation build directory: docs/ or doc/, or one holding a Sphinx index. */
function isDocsRoot(root: string, fileSet: ReadonlySet<string>): boolean {
  const name = baseName(root).toLowerCase();
  return (
    name === "docs" ||
    name === "doc" ||
    fileSet.has(joinPath(root, "index.rst")) ||
    (fileSet.has(joinPath(root, "conf.py")) && fileSet.has(joinPath(root, "index.md")))
  );
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

/** Manifests found directly in one root, in a stable order. */
function manifestsIn(root: string, files: readonly string[]): string[] {
  return files
    .filter(
      (file) =>
        (dirName(file) === root && isRootManifest(file)) ||
        (isRequirementsDirFile(file) && manifestRoot(file) === root),
    )
    .sort();
}

/** Package managers signalled by files in one root. Lockfiles first, then manifests. */
async function detectPackageManagers(
  context: AdapterContext,
  root: string,
  fileSet: ReadonlySet<string>,
  manifests: readonly string[],
): Promise<{ managers: PackageManager[]; evidence: Evidence[] }> {
  const managers: PackageManager[] = [];
  const evidence: Evidence[] = [];
  const add = (name: string, lockfile?: string): void => {
    if (managers.some((m) => m.name === name)) return;
    managers.push(lockfile === undefined ? { name } : { name, lockfile });
  };
  for (const [lockfile, manager] of LOCKFILES) {
    const path = joinPath(root, lockfile);
    if (!fileSet.has(path)) continue;
    add(manager, lockfile);
    evidence.push({
      kind: "lockfile-found",
      statement: `${lockfile} at ${displayRoot(root)} identifies ${manager}`,
      file: path,
    });
  }
  const pyproject = joinPath(root, "pyproject.toml");
  if (fileSet.has(pyproject) && !managers.some((m) => m.name === "poetry")) {
    // A plain text check: TOML parsing is #43's job, and a table header is
    // unambiguous enough to name the manager without evaluating anything.
    let text = "";
    try {
      text = await context.repository.readFile(pyproject);
    } catch {
      // Unreadable manifests surface in the detection evidence below.
    }
    if (/^\s*\[tool\.poetry[\].]/m.test(text)) {
      add("poetry");
      evidence.push({
        kind: "package-manager-found",
        statement: `${pyproject} declares [tool.poetry]`,
        file: pyproject,
      });
    }
  }
  if (fileSet.has(joinPath(root, "Pipfile"))) add("pipenv");
  if (
    managers.length === 0 &&
    manifests.some((m) => isRequirementsFile(baseName(m)) || isRequirementsDirFile(m))
  ) {
    add("pip");
  }
  return { managers, evidence };
}

export async function detectPython(context: AdapterContext): Promise<DetectionResult> {
  const { repository } = context;
  const files = (await repository.listFiles()).filter((file) => !hasExcludedSegment(file));
  const fileSet = new Set(files);
  const roots = [
    ...new Set(
      files.filter((file) => isRootManifest(file) || isRequirementsDirFile(file)).map(manifestRoot),
    ),
  ].sort((a, b) => a.length - b.length || a.localeCompare(b));

  if (roots.length === 0) {
    return { confidence: 0, projects: [], evidence: [] };
  }

  const rootSet = new Set(roots);
  const sourceCountByRoot = new Map<string, number>(roots.map((root) => [root, 0]));
  // Sphinx's conf.py configures a docs build; it is not project source.
  const sphinxConf = (file: string): boolean =>
    baseName(file) === "conf.py" && isDocsRoot(dirName(file), fileSet);
  for (const file of files.filter((f) => isSourceFile(f) && !sphinxConf(f))) {
    const root = nearestRoot(file, rootSet);
    if (root !== undefined) sourceCountByRoot.set(root, (sourceCountByRoot.get(root) ?? 0) + 1);
  }

  const evidence: Evidence[] = [];
  const projects: ProjectRef[] = [];
  let best = 0;

  for (const root of roots) {
    const manifests = manifestsIn(root, files);
    for (const manifest of manifests) {
      evidence.push({ kind: "manifest-found", statement: `found ${manifest}`, file: manifest });
    }
    if (manifests.some((m) => baseName(m) === "setup.py")) {
      evidence.push({
        kind: "setup-py-unanalysable",
        statement: `${joinPath(root, "setup.py")} is code; it is recorded but never executed`,
        file: joinPath(root, "setup.py"),
      });
    }

    const sourceCount = sourceCountByRoot.get(root) ?? 0;
    const pm = await detectPackageManagers(context, root, fileSet, manifests);
    let confidence: number;

    const docsOnly =
      isDocsRoot(root, fileSet) &&
      manifests.every((m) => isRequirementsFile(baseName(m)) || isRequirementsDirFile(m));

    if (docsOnly) {
      // docs/requirements.txt pins the documentation toolchain (Sphinx and
      // friends), not a Python project whose dependencies we should judge.
      confidence = 0.3;
      evidence.push({
        kind: "docs-build",
        statement: `${displayRoot(root)} is a documentation build; its requirements are not a Python project`,
      });
    } else if (sourceCount === 0) {
      confidence = 0.3;
      evidence.push({
        kind: "no-python-source",
        statement: `no meaningful Python source under ${displayRoot(root)}`,
      });
    } else {
      confidence = 0.7;
      evidence.push({
        kind: "source-files",
        statement: `${sourceCount} Python source file(s) under ${displayRoot(root)}`,
      });
      if (pm.managers.some((m) => m.lockfile !== undefined)) confidence += 0.1;
      if (manifests.some((m) => baseName(m) === "pyproject.toml")) confidence += 0.1;
      if (sourceCount >= 5) confidence += 0.1;
      confidence = Math.min(confidence, 1);
      evidence.push(...pm.evidence);
    }

    // Round to 2dp: float arithmetic makes 0.7+0.1+0.1+0.1 == 0.9999...
    confidence = Math.round(confidence * 100) / 100;
    best = Math.max(best, confidence);
    if (confidence >= DETECTION_CONFIDENCE_THRESHOLD) {
      projects.push({ path: root, ecosystem: PYTHON_ECOSYSTEM, packageManagers: pm.managers });
    } else {
      evidence.push({
        kind: "project-skipped",
        statement: `skipped ${displayRoot(root)}: confidence ${confidence.toFixed(2)} is below the detection threshold ${DETECTION_CONFIDENCE_THRESHOLD}`,
      });
    }
  }

  return { confidence: best, projects, evidence };
}
