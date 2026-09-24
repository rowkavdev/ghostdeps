/**
 * Go module detection (#52). A project is a directory holding a go.mod.
 * Directories the go command ignores (vendor/, testdata/, and names that
 * start with "." or "_") never hold projects.
 */
import type { DetectionResult, Evidence, ProjectRef, RepositoryHandle } from "@ghostdeps/core";

export const GO_ECOSYSTEM = "go";

/** Confidence with a go.mod present; loose .go files alone stay below core's threshold. */
const MODULE_CONFIDENCE = 0.95;
const SOURCE_ONLY_CONFIDENCE = 0.2;

/** True when the go command would skip this path (vendor, testdata, "." or "_" dirs). */
export function isIgnoredGoPath(path: string): boolean {
  const dirs = path.split("/").slice(0, -1);
  return dirs.some(
    (d) => d === "vendor" || d === "testdata" || d.startsWith(".") || d.startsWith("_"),
  );
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "." : path.slice(0, i);
}

export function joinPath(dir: string, file: string): string {
  return dir === "." ? file : `${dir}/${file}`;
}

export async function detectGo(repository: RepositoryHandle): Promise<DetectionResult> {
  const files = await repository.listFiles();
  const fileSet = new Set(files);
  const evidence: Evidence[] = [];
  const projects: ProjectRef[] = [];

  for (const file of files) {
    if (!(file === "go.mod" || file.endsWith("/go.mod")) || isIgnoredGoPath(file)) continue;
    const dir = dirOf(file);
    const sum = joinPath(dir, "go.sum");
    projects.push({
      path: dir,
      ecosystem: GO_ECOSYSTEM,
      packageManagers: [
        { name: "go-modules", ...(fileSet.has(sum) ? { lockfile: "go.sum" } : {}) },
      ],
    });
    evidence.push({ kind: "manifest-found", statement: `go.mod at ${file}`, file });
  }
  for (const file of files) {
    if ((file === "go.work" || file.endsWith("/go.work")) && !isIgnoredGoPath(file)) {
      evidence.push({ kind: "workspace-found", statement: `go.work at ${file}`, file });
    }
  }
  const sources = files.filter((f) => f.endsWith(".go") && !isIgnoredGoPath(f)).length;
  if (sources > 0) {
    evidence.push({ kind: "source-files", statement: `${sources} .go source files` });
  }

  const confidence =
    projects.length > 0 ? MODULE_CONFIDENCE : sources > 0 ? SOURCE_ONLY_CONFIDENCE : 0;
  return { confidence, projects, evidence };
}
