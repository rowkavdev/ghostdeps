/**
 * requirements.txt parsing (issue #44): pins, ranges, markers, hashes,
 * editable and URL requirements, and -r/-c includes resolved relative to the
 * including file. Pure text work: nothing is fetched, installed or run.
 */
import type {
  Dependency,
  DependencyKind,
  Evidence,
  ProjectRef,
  RepositoryHandle,
} from "@ghostdeps/core";
import { normaliseName, parseRequirement } from "./pep508.js";
import { baseName, dirName, joinPath } from "./paths.js";
import { classifyUrl, mergeMarkers, type PythonRequirement } from "./pyproject.js";
import { isRequirementsFile } from "./detect.js";

/** Include chains deeper than this are cut off with a note (hostile input). */
export const MAX_INCLUDE_DEPTH = 8;
/** Requirements files above this are not parsed (hostile input bound). */
export const MAX_REQUIREMENTS_BYTES = 1024 * 1024;
/** Total requirements files read per project. */
export const MAX_REQUIREMENTS_FILES = 64;

export interface RequirementsParseResult {
  requirements: PythonRequirement[];
  evidence: Evidence[];
}

/** requirements-dev.txt, test-requirements.txt, requirements/lint.txt ... are dev. */
export function requirementsKind(path: string): DependencyKind {
  return /(?:^|[-_./])(?:dev|develop|test|tests|testing|lint|docs?|ci|typing|tools?)(?:[-_./]|$)/i.test(
    path,
  )
    ? "dev"
    : "runtime";
}

/** Join a relative include onto a directory; undefined if it leaves the repository. */
export function resolveInclude(fromFile: string, target: string): string | undefined {
  if (target.startsWith("/") || /^[a-z][\w+.-]*:/i.test(target) || target.includes("\\")) {
    return undefined;
  }
  const parts = dirName(fromFile) === "." ? [] : dirName(fromFile).split("/");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

/** Logical lines: comments stripped, backslash continuations joined. */
function logicalLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let buffer = "";
  let start = 0;
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]!;
    if (buffer === "") start = i + 1;
    // A "#" at line start or after whitespace starts a comment (pip's rule).
    line = line.replace(/(^|\s)#.*$/, "");
    if (line.endsWith("\\")) {
      buffer += line.slice(0, -1) + " ";
      continue;
    }
    buffer += line;
    if (buffer.trim().length > 0) out.push({ line: start, text: buffer.trim() });
    buffer = "";
  }
  if (buffer.trim().length > 0) out.push({ line: start, text: buffer.trim() });
  return out;
}

/** "#egg=name" on VCS/URL requirements names the package. */
function eggName(url: string): string | undefined {
  return /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(url)?.[1];
}

/** Direct requirements files for a project, skipping compiled pip-tools output. */
export function requirementsEntryPoints(
  project: ProjectRef,
  files: readonly string[],
): { entries: string[]; evidence: Evidence[] } {
  const inRoot = files.filter(
    (file) =>
      (dirName(file) === project.path && isRequirementsFile(baseName(file))) ||
      (dirName(file) === joinPath(project.path, "requirements") && /\.(?:txt|in)$/.test(file)),
  );
  const fileSet = new Set(inRoot);
  const evidence: Evidence[] = [];
  const entries = inRoot.filter((file) => {
    if (!file.endsWith(".txt")) return true;
    const source = `${file.slice(0, -".txt".length)}.in`;
    if (!fileSet.has(source)) return true;
    evidence.push({
      kind: "requirements-compiled",
      statement: `${file} is compiled from ${source}; direct dependencies are read from ${source}`,
      file,
    });
    return false;
  });
  return { entries: entries.sort(), evidence };
}

export async function parseRequirementsFiles(
  repository: RepositoryHandle,
  project: ProjectRef,
  entries: readonly string[],
): Promise<RequirementsParseResult> {
  const requirements: PythonRequirement[] = [];
  const evidence: Evidence[] = [];
  const read = new Set<string>();

  // One Dependency per name and kind across all requirements files (the
  // rule every adapter follows): the first file that declares it is
  // declaredIn; later repeats only merge extras and clear a marker.
  const byKey = new Map<string, PythonRequirement>();
  const add = (
    name: string,
    constraint: string,
    kind: DependencyKind,
    declaredIn: string,
    extras: string[],
    marker: string | undefined,
    specifier: Dependency["specifier"] | undefined,
  ): void => {
    const normalised = normaliseName(name);
    const key = `${normalised}\0${kind}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      for (const extra of extras) if (!existing.extras.includes(extra)) existing.extras.push(extra);
      if (existing.dependency.constraint === "*" && constraint.length > 0) {
        existing.dependency.constraint = constraint;
      }
      const merged = mergeMarkers(existing.marker, marker);
      if (merged === undefined) delete existing.marker;
      else existing.marker = merged;
      return;
    }
    const dependency: Dependency = {
      name: normalised,
      constraint: constraint.length > 0 ? constraint : "*",
      kind,
      project,
      declaredIn,
    };
    if (specifier !== undefined) dependency.specifier = specifier;
    const requirement: PythonRequirement = { dependency, extras: [...extras], groups: [] };
    if (marker !== undefined) requirement.marker = marker;
    byKey.set(key, requirement);
    requirements.push(requirement);
  };

  const note = (kind: string, statement: string, file: string, line?: number): void => {
    evidence.push(line === undefined ? { kind, statement, file } : { kind, statement, file, line });
  };

  // kind is inherited from the entry file: requirements-dev.txt -r base.txt
  // makes base.txt's packages dev only if base.txt is never read directly.
  async function visit(
    file: string,
    depth: number,
    kind: DependencyKind,
    constraintsOnly: boolean,
  ): Promise<void> {
    if (read.has(file)) return;
    if (read.size >= MAX_REQUIREMENTS_FILES) {
      note(
        "requirements-limit",
        `stopped before ${file}: more than ${MAX_REQUIREMENTS_FILES} requirements files`,
        file,
      );
      return;
    }
    read.add(file);
    let text: string;
    try {
      text = await repository.readFile(file);
    } catch {
      note("requirements-unreadable", `${file} could not be read`, file);
      return;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_REQUIREMENTS_BYTES) {
      note(
        "requirements-oversized",
        `${file} exceeds ${MAX_REQUIREMENTS_BYTES} bytes and was not parsed`,
        file,
      );
      return;
    }
    for (const { line, text: entry } of logicalLines(text)) {
      const option = /^(-r|--requirement|-c|--constraint)(?:\s+|=)(.+)$/.exec(entry);
      if (option) {
        const constraint = option[1] === "-c" || option[1] === "--constraint";
        const target = resolveInclude(file, option[2]!.trim());
        if (target === undefined) {
          note(
            "requirements-include-skipped",
            `${file}:${line} includes ${option[2]!.trim()}, which is outside the repository or remote; not followed`,
            file,
            line,
          );
        } else if (depth + 1 > MAX_INCLUDE_DEPTH) {
          note(
            "requirements-limit",
            `${file}:${line} include chain deeper than ${MAX_INCLUDE_DEPTH}; not followed`,
            file,
            line,
          );
        } else if (!(await repository.exists(target))) {
          note(
            "requirements-include-missing",
            `${file}:${line} includes ${target}, which does not exist`,
            file,
            line,
          );
        } else {
          await visit(target, depth + 1, kind, constraintsOnly || constraint);
        }
        continue;
      }
      if (constraintsOnly) continue; // constraint files pin, they never declare.
      const editable = /^(?:-e|--editable)(?:\s+|=)(.+)$/.exec(entry);
      if (editable || /^[a-z][\w+.-]*:\/\//i.test(entry) || entry.startsWith("git+")) {
        const url = (editable?.[1] ?? entry).trim().split(/\s+/)[0]!;
        const name = eggName(url);
        if (name === undefined) {
          note(
            "requirement-unresolved",
            `${file}:${line} is an ${editable ? "editable" : "URL"} requirement with no package name; not attributed`,
            file,
            line,
          );
        } else {
          const specifier = /^(?:\.|\/|file:)/.test(url)
            ? { type: "file" as const, detail: url }
            : classifyUrl(url);
          add(name, url, kind, file, [], undefined, specifier);
        }
        continue;
      }
      if (entry.startsWith("-")) continue; // --hash, -i, --index-url, --pre ... carry no dependency.
      if (/^\.{0,2}\//.test(entry)) {
        note(
          "requirement-unresolved",
          `${file}:${line} is a local path requirement; not attributed`,
          file,
          line,
        );
        continue;
      }
      // Per-requirement options (--hash=...) follow the requirement.
      // Everything from the first whitespace-delimited "--" on is options.
      const optionStart = entry.search(/\s--[\w-]/);
      const requirementText = (optionStart === -1 ? entry : entry.slice(0, optionStart)).trim();
      const req = parseRequirement(requirementText);
      if (req === undefined) {
        note(
          "requirement-unparsed",
          `could not parse "${requirementText.slice(0, 200)}" at ${file}:${line}`,
          file,
          line,
        );
        continue;
      }
      const specifier = req.url !== undefined ? classifyUrl(req.url) : undefined;
      add(req.rawName, req.url ?? req.specifier, kind, file, req.extras, req.marker, specifier);
    }
  }

  // Runtime entry points first: requirements-dev.txt usually starts with
  // "-r requirements.txt", and the shared base must be read as runtime
  // before a dev file can pull it in (each file is read once).
  const ordered = [...entries].sort(
    (a, b) => Number(requirementsKind(a) === "dev") - Number(requirementsKind(b) === "dev"),
  );
  for (const entry of ordered) await visit(entry, 0, requirementsKind(entry), false);
  return { requirements, evidence };
}
