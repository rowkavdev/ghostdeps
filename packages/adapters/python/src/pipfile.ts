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
      if (
        !valid ||
        (constraint !== undefined && typeof constraint !== "string") ||
        (options?.extras !== undefined &&
          strings(options.extras).length !==
            (Array.isArray(options.extras) ? options.extras.length : -1))
      ) {
        incomplete = true;
        evidence.push({
          kind: "manifest-malformed",
          statement: `could not read ${rawName} in ${declaredIn} [${section}]`,
          file: declaredIn,
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
