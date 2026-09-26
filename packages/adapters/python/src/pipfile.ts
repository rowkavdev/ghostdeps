/** Static Pipfile declarations (#432). Nothing is installed or evaluated. */
import { parse as parseToml } from "smol-toml";
import type { Dependency, Evidence, ProjectRef } from "@ghostdeps/core";
import { PyprojectLines } from "./declared-line.js";
import { normaliseName } from "./pep508.js";
import { classifyUrl, type PythonRequirement } from "./pyproject.js";

export interface PipfileParseResult {
  requirements: PythonRequirement[];
  evidence: Evidence[];
  malformed: boolean;
  /** A valid [packages] table must be present to regard runtime declarations as complete. */
  complete: boolean;
}

type Table = Record<string, unknown>;
const table = (value: unknown): Table | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Table)
    : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : [];

const SUPPORTED_OPTIONS = new Set([
  "version",
  "extras",
  "markers",
  "git",
  "path",
  "file",
  "url",
  "ref",
  "editable",
  "index",
  "subdirectory",
  "os_name",
  "sys_platform",
  "platform_machine",
  "platform_python_implementation",
  "platform_release",
  "platform_system",
  "platform_version",
  "python_version",
  "python_full_version",
  "implementation_name",
  "implementation_version",
  "extra",
]);
const STRING_OPTIONS = new Set(
  [...SUPPORTED_OPTIONS].filter((key) => key !== "extras" && key !== "editable"),
);
function validOptions(options: Table): boolean {
  if (
    Object.entries(options).some(
      ([key, value]) =>
        !SUPPORTED_OPTIONS.has(key) ||
        (STRING_OPTIONS.has(key) && typeof value !== "string") ||
        (key === "editable" && typeof value !== "boolean") ||
        (key === "extras" &&
          (!Array.isArray(value) || value.some((item) => typeof item !== "string"))),
    )
  )
    return false;
  const refs = ["git", "path", "file", "url"].filter((key) => options[key] !== undefined);
  return refs.length <= 1 && (refs.length === 0 || options.version === undefined);
}

export function parsePipfileText(
  text: string,
  project: ProjectRef,
  declaredIn: string,
): PipfileParseResult {
  let doc: Table | undefined;
  try {
    doc = table(parseToml(text));
  } catch (error) {
    const line = (error as { line?: unknown } | null)?.line;
    const at = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
    return {
      requirements: [],
      evidence: [
        {
          kind: "manifest-malformed",
          statement: `${declaredIn}${at !== undefined ? `:${at}` : ""}: invalid TOML; Pipfile runtime section not parsed`,
          file: declaredIn,
          ...(at !== undefined ? { line: at } : {}),
        },
      ],
      malformed: true,
      complete: false,
    };
  }
  const evidence: Evidence[] = [];
  const requirements: PythonRequirement[] = [];
  const lines = new PyprojectLines(text);
  const byKey = new Map<string, PythonRequirement>();
  const missingRuntime = doc === undefined || table(doc.packages) === undefined;
  let incomplete = missingRuntime;
  if (missingRuntime) {
    evidence.push({
      kind: "manifest-malformed",
      statement: `${declaredIn}: Pipfile runtime section not parsed (missing [packages])`,
      file: declaredIn,
    });
  }
  for (const [section, kind] of [
    ["packages", "runtime"],
    ["dev-packages", "dev"],
  ] as const) {
    const entries = table(doc?.[section]);
    if (entries === undefined) continue;
    for (const [rawName, raw] of Object.entries(entries)) {
      const name = normaliseName(rawName);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        incomplete = true;
        evidence.push({
          kind: "manifest-malformed",
          statement: `invalid package name ${rawName.slice(0, 100)} in ${declaredIn}`,
          file: declaredIn,
        });
        continue;
      }
      const options = table(raw);
      const valid = typeof raw === "string" || options !== undefined;
      const constraint = typeof raw === "string" ? raw : options?.version;
      if (!valid || (options !== undefined && !validOptions(options))) {
        incomplete = true;
        const line = lines.tableKey(section, rawName, name);
        evidence.push({
          kind: "manifest-malformed",
          statement: `could not read ${rawName} in ${declaredIn} [${section}]`,
          file: declaredIn,
          ...(line !== undefined ? { line } : {}),
        });
        continue;
      }
      let specifier: Dependency["specifier"];
      for (const key of ["git", "path", "file", "url"] as const) {
        const value = options?.[key];
        if (typeof value !== "string") continue;
        specifier =
          key === "git"
            ? { type: "git", detail: value }
            : key === "path" || key === "file"
              ? { type: "file", detail: value }
              : classifyUrl(value);
        break;
      }
      const key = `${name}\0${kind}`;
      const existing = byKey.get(key);
      if (existing) continue;
      const dependency: Dependency = {
        name,
        kind,
        project,
        declaredIn,
        constraint:
          specifier?.detail ??
          (typeof constraint === "string" && constraint.length > 0 ? constraint : "*"),
      };
      if (specifier) dependency.specifier = specifier;
      const line = lines.tableKey(section, rawName, name);
      if (line !== undefined) dependency.declaredLine = line;
      const requirement: PythonRequirement = {
        dependency,
        extras: strings(options?.extras).map(normaliseName),
        groups: [],
      };
      const marker = options?.markers;
      if (typeof marker === "string") requirement.marker = marker;
      byKey.set(key, requirement);
      requirements.push(requirement);
    }
  }
  return { requirements, evidence, malformed: false, complete: !incomplete };
}
