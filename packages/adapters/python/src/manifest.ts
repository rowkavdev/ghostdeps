/**
 * Per-project manifest reading: pyproject.toml (#43), requirements files
 * (#44), and Pipfile (#432). Read failures and malformed files become evidence,
 * never exceptions.
 */
import type { Evidence, ProjectRef, RepositoryHandle } from "@ghostdeps/core";
import { MAX_PYPROJECT_BYTES } from "./detect.js";
import { joinPath } from "./paths.js";
import { parsePipfileText } from "./pipfile.js";
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
  const pipfile = joinPath(project.path, "Pipfile");
  if (await repository.exists(pipfile)) {
    let text: string | undefined;
    try {
      text = await repository.readFile(pipfile);
    } catch {
      result.evidence.push({
        kind: "manifest-malformed",
        statement: `${pipfile} could not be read; Pipfile runtime section not parsed`,
        file: pipfile,
      });
    }
    if (text !== undefined && Buffer.byteLength(text, "utf8") > MAX_PYPROJECT_BYTES) {
      result.evidence.push({
        kind: "manifest-malformed",
        statement: `${pipfile} exceeds ${MAX_PYPROJECT_BYTES} bytes; Pipfile runtime section not parsed`,
        file: pipfile,
      });
      text = undefined;
    }
    if (text !== undefined) {
      const parsed = parsePipfileText(text, project, pipfile);
      result.requirements.push(...parsed.requirements);
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
