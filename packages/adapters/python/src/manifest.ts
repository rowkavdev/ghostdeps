/**
 * Per-project manifest reading: pyproject.toml (#43) and requirements
 * files (#44). Read failures and malformed files become evidence,
 * never exceptions.
 */
import type { Evidence, ProjectRef, RepositoryHandle } from "@ghostdeps/core";
import { MAX_PYPROJECT_BYTES } from "./detect.js";
import { joinPath } from "./paths.js";
import { parsePyprojectText, type PythonRequirement } from "./pyproject.js";
import { parseRequirementsFiles, requirementsEntryPoints } from "./requirements.js";

export interface ManifestParseResult {
  requirements: PythonRequirement[];
  extras: Record<string, string[]>;
  evidence: Evidence[];
}

export async function parseManifests(
  repository: RepositoryHandle,
  project: ProjectRef,
): Promise<ManifestParseResult> {
  const result: ManifestParseResult = { requirements: [], extras: {}, evidence: [] };
  const pyproject = joinPath(project.path, "pyproject.toml");
  if (await repository.exists(pyproject)) {
    let text: string | undefined;
    try {
      text = await repository.readFile(pyproject);
    } catch {
      result.evidence.push({
        kind: "manifest-unreadable",
        statement: `${pyproject} could not be read`,
        file: pyproject,
      });
    }
    if (text !== undefined && Buffer.byteLength(text, "utf8") > MAX_PYPROJECT_BYTES) {
      result.evidence.push({
        kind: "manifest-too-large",
        statement: `${pyproject} exceeds ${MAX_PYPROJECT_BYTES} bytes and was not parsed`,
        file: pyproject,
      });
      text = undefined;
    }
    if (text !== undefined) {
      const parsed = parsePyprojectText(text, project, pyproject);
      result.requirements.push(...parsed.requirements);
      Object.assign(result.extras, parsed.extras);
      result.evidence.push(...parsed.evidence);
    }
  }
  const { entries, evidence } = requirementsEntryPoints(project, await repository.listFiles());
  result.evidence.push(...evidence);
  if (entries.length > 0) {
    const parsed = await parseRequirementsFiles(repository, project, entries);
    result.requirements.push(...parsed.requirements);
    result.evidence.push(...parsed.evidence);
  }
  return result;
}
