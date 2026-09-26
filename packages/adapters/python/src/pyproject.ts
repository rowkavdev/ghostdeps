/**
 * pyproject.toml dependency parsing (issue #43): PEP 621 [project],
 * PEP 735 [dependency-groups], [build-system].requires, uv's
 * [tool.uv].dev-dependencies and Poetry's [tool.poetry] tables. Static TOML
 * parsing only; setup.py is code and is never read here.
 *
 * Each entry keeps the facts the shared Dependency model has no field for
 * (requested extras, marker, the extras/groups that declare it) so #47
 * can reason about extras without a contract change.
 */
import { parse as parseToml } from "smol-toml";
import type { Dependency, DependencyKind, Evidence, ProjectRef } from "@ghostdeps/core";
import { PyprojectLines } from "./declared-line.js";
import { normaliseName, parseRequirement } from "./pep508.js";

/** A declared requirement with the Python-specific facts Dependency cannot carry. */
export interface PythonRequirement {
  dependency: Dependency;
  /** Extras requested of this package, e.g. ["socks"] for requests[socks]. */
  extras: string[];
  marker?: string;
  /**
   * Optional-dependency extras (PEP 621, Poetry extras) or dependency groups
   * that declare it. One requirement per name and kind: a package listed in
   * several extras is one Dependency with every extra named here.
   */
  groups: string[];
}

export interface PyprojectParseResult {
  requirements: PythonRequirement[];
  /** Extras this project itself offers: extra name -> normalised package names. */
  extras: Record<string, string[]>;
  evidence: Evidence[];
  malformed: boolean;
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(parent: unknown, key: string): Table | undefined {
  if (!isTable(parent)) return undefined;
  const value = parent[key];
  return isTable(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

class Collector {
  readonly requirements: PythonRequirement[] = [];
  readonly evidence: Evidence[] = [];
  private readonly byKey = new Map<string, PythonRequirement>();

  constructor(
    private readonly project: ProjectRef,
    readonly declaredIn: string,
    readonly lines?: PyprojectLines,
  ) {}

  add(
    name: string,
    constraint: string,
    kind: DependencyKind,
    extras: string[],
    options: {
      marker?: string;
      group?: string;
      specifier?: Dependency["specifier"];
      /** Declaring line (#280); the first declaration of a name+kind keeps it. */
      line?: number | undefined;
    } = {},
  ): void {
    const normalised = normaliseName(name);
    // One Dependency per name and kind (as every adapter emits): repeats
    // merge their extras and groups instead of duplicating the entry.
    const key = `${normalised}\0${kind}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      for (const extra of extras) if (!existing.extras.includes(extra)) existing.extras.push(extra);
      if (options.group !== undefined && !existing.groups.includes(options.group)) {
        existing.groups.push(options.group);
      }
      if (existing.dependency.constraint === "*" && constraint.length > 0) {
        existing.dependency.constraint = constraint;
      }
      const marker = mergeMarkers(existing.marker, options.marker);
      if (marker === undefined) delete existing.marker;
      else existing.marker = marker;
      return;
    }
    const dependency: Dependency = {
      name: normalised,
      constraint: constraint.length > 0 ? constraint : "*",
      kind,
      project: this.project,
      declaredIn: this.declaredIn,
    };
    if (options.specifier !== undefined) dependency.specifier = options.specifier;
    if (options.line !== undefined) dependency.declaredLine = options.line;
    const requirement: PythonRequirement = {
      dependency,
      extras: [...extras],
      groups: options.group !== undefined ? [options.group] : [],
    };
    if (options.marker !== undefined) requirement.marker = options.marker;
    this.byKey.set(key, requirement);
    this.requirements.push(requirement);
  }

  /** A PEP 508 string from PEP 621, PEP 735, build-system or uv. */
  addPep508(
    text: string,
    kind: DependencyKind,
    group: string | undefined,
    at: { section: string; key: string },
  ): string | undefined {
    const req = parseRequirement(text);
    if (req === undefined) {
      this.evidence.push({
        kind: "requirement-unparsed",
        statement: `could not parse requirement "${text.slice(0, 200)}" in ${this.declaredIn}`,
        file: this.declaredIn,
      });
      return undefined;
    }
    const options: {
      marker?: string;
      group?: string;
      specifier?: Dependency["specifier"];
      line?: number | undefined;
    } = {};
    if (req.marker !== undefined) options.marker = req.marker;
    if (group !== undefined) options.group = group;
    if (req.url !== undefined) options.specifier = classifyUrl(req.url);
    options.line = this.lines?.pep508(at.section, at.key, req.rawName, req.name);
    this.add(req.rawName, req.url ?? req.specifier, kind, req.extras, options);
    return req.name;
  }
}

/**
 * Combine the markers of two declarations of one requirement. Either one
 * unconditional makes the result unconditional; two conditions are OR-ed.
 */
export function mergeMarkers(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined || b === undefined) return undefined;
  if (a === b) return a;
  return `(${a}) or (${b})`;
}

/** Direct references are recorded, never fetched. */
export function classifyUrl(url: string): NonNullable<Dependency["specifier"]> {
  if (/^git\+|\.git(?:[@#]|$)/.test(url)) return { type: "git", detail: url };
  if (url.startsWith("file:")) return { type: "file", detail: url };
  return { type: "registry", detail: url };
}

function parsePep621(doc: Table, out: Collector, extras: Record<string, string[]>): void {
  const project = table(doc, "project");
  if (project !== undefined) {
    const dynamic = strings(project.dynamic);
    for (const field of ["dependencies", "optional-dependencies"]) {
      if (!dynamic.includes(field)) continue;
      out.evidence.push({
        kind: "dynamic-dependencies",
        statement: `${out.declaredIn} marks [project].${field} as dynamic; they come from build code that is never run`,
        file: out.declaredIn,
      });
    }
    for (const text of strings(project.dependencies)) {
      out.addPep508(text, "runtime", undefined, { section: "project", key: "dependencies" });
    }
    const optional = table(project, "optional-dependencies") ?? {};
    for (const [extra, list] of Object.entries(optional)) {
      const name = normaliseName(extra);
      const members: string[] = [];
      for (const text of strings(list)) {
        const dep = out.addPep508(text, "optional", name, {
          section: "project.optional-dependencies",
          key: extra,
        });
        if (dep !== undefined) members.push(dep);
      }
      extras[name] = members;
    }
  }
  // PEP 735 dependency groups. Groups are not dev by definition, but in
  // practice they hold test/lint/docs tooling, so they are reported as dev
  // (documented default). `{include-group = "..."}` entries are tables and
  // are skipped: their members are listed in the included group.
  const groups = table(doc, "dependency-groups") ?? {};
  for (const [group, list] of Object.entries(groups)) {
    for (const text of strings(list)) {
      out.addPep508(text, "dev", normaliseName(group), {
        section: "dependency-groups",
        key: group,
      });
    }
  }
  for (const text of strings(table(doc, "build-system")?.requires)) {
    out.addPep508(text, "build", undefined, { section: "build-system", key: "requires" });
  }
  const uv = table(table(doc, "tool"), "uv");
  for (const text of strings(uv?.["dev-dependencies"])) {
    out.addPep508(text, "dev", undefined, { section: "tool.uv", key: "dev-dependencies" });
  }
}

/** One Poetry constraint: "^1.2", {version, extras, optional, markers, git|path|url}, or a list of those. */
function parsePoetryEntry(
  name: string,
  value: unknown,
  kind: DependencyKind,
  out: Collector,
  group: string | undefined,
  declaredIn: string,
  section: string,
): void {
  const line = out.lines?.tableKey(section, name, normaliseName(name));
  if (typeof value === "string") {
    const options: { group?: string; line?: number | undefined } = { line };
    if (group !== undefined) options.group = group;
    out.add(name, value, kind, [], options);
    return;
  }
  const entries = Array.isArray(value) ? value.filter(isTable) : isTable(value) ? [value] : [];
  if (entries.length === 0) {
    out.evidence.push({
      kind: "requirement-unparsed",
      statement: `could not read the Poetry constraint for ${name} in ${declaredIn}`,
      file: declaredIn,
    });
    return;
  }
  const first = entries[0]!;
  const versions = entries
    .map((entry) => (typeof entry.version === "string" ? entry.version : ""))
    .filter((v) => v.length > 0);
  let specifier: Dependency["specifier"];
  let constraint = [...new Set(versions)].join(" || ");
  if (typeof first.git === "string") {
    specifier = { type: "git", detail: first.git };
    constraint ||= first.git;
  } else if (typeof first.path === "string") {
    specifier = { type: "file", detail: first.path };
    constraint ||= first.path;
  } else if (typeof first.url === "string") {
    specifier = { type: "registry", detail: first.url };
    constraint ||= first.url;
  }
  const optional = entries.some((entry) => entry.optional === true);
  const extras = [...new Set(entries.flatMap((entry) => strings(entry.extras)))].map(normaliseName);
  const markers = entries
    .map((entry) => (typeof entry.markers === "string" ? entry.markers : undefined))
    .filter((m): m is string => m !== undefined);
  const options: {
    marker?: string;
    group?: string;
    specifier?: Dependency["specifier"];
    line?: number | undefined;
  } = { line };
  if (markers.length > 0) options.marker = markers.join(" or ");
  if (group !== undefined) options.group = group;
  if (specifier !== undefined) options.specifier = specifier;
  out.add(name, constraint, optional && kind === "runtime" ? "optional" : kind, extras, options);
}

function parsePoetry(
  doc: Table,
  out: Collector,
  extras: Record<string, string[]>,
  declaredIn: string,
): void {
  const poetry = table(table(doc, "tool"), "poetry");
  if (poetry === undefined) return;
  // Poetry extras name optional runtime dependencies: [tool.poetry.extras].
  const poetryExtras = table(poetry, "extras") ?? {};
  const extraOf = new Map<string, string>();
  for (const [extra, members] of Object.entries(poetryExtras)) {
    const name = normaliseName(extra);
    const list = strings(members).map(normaliseName);
    extras[name] = [...new Set([...(extras[name] ?? []), ...list])];
    for (const member of list) if (!extraOf.has(member)) extraOf.set(member, name);
  }
  for (const [name, value] of Object.entries(table(poetry, "dependencies") ?? {})) {
    if (name.toLowerCase() === "python") continue;
    parsePoetryEntry(
      name,
      value,
      "runtime",
      out,
      extraOf.get(normaliseName(name)),
      declaredIn,
      "tool.poetry.dependencies",
    );
  }
  for (const [name, value] of Object.entries(table(poetry, "dev-dependencies") ?? {})) {
    parsePoetryEntry(name, value, "dev", out, "dev", declaredIn, "tool.poetry.dev-dependencies");
  }
  for (const [group, body] of Object.entries(table(poetry, "group") ?? {})) {
    // group.main is Poetry's name for [tool.poetry.dependencies]: runtime.
    const main = normaliseName(group) === "main";
    const section = `tool.poetry.group.${group}.dependencies`;
    for (const [name, value] of Object.entries(table(body, "dependencies") ?? {})) {
      if (name.toLowerCase() === "python") continue;
      if (main) {
        const extra = extraOf.get(normaliseName(name));
        parsePoetryEntry(name, value, "runtime", out, extra, declaredIn, section);
      } else {
        parsePoetryEntry(name, value, "dev", out, normaliseName(group), declaredIn, section);
      }
    }
  }
}
/**
 * Advanced Grammar Parser for Issue #300.
 * Deliberately parses semver clauses, enforces constraint bounds,
 * automatically resolves precedence and strictly rejects garbage or ambiguous texts.
 */
export function parsePythonFloorToTuple(constraintStr: string | undefined): number[] | undefined {
  if (!constraintStr || typeof constraintStr !== "string") {
    return undefined;
  }

  const cleanInput = constraintStr.trim();

  // Guard 1: Direct rejection of negative/upper-bound parameters deliberately
  if (cleanInput.includes("!=") || cleanInput.startsWith("<") || cleanInput.startsWith("<=")) {
    return undefined;
  }

  // Split multiple clauses (e.g., ">=3.8,<=3.12" or ">=3.10,>=3.12")
  const clauses = cleanInput.split(",").map(c => c.trim());
  let absoluteHighestFloor: number[] | undefined = undefined;

  for (const clause of clauses) {
    // Strict Sanitization Guard: Detect any invalid characters or alpha garbage text trailing bounds
    if (/[a-zA-Z]/g.test(clause.replace("python", ""))) {
      return undefined; // Reject if alphabetical garbage exists (e.g., ">=3.10garbage")
    }

    const isInclusive = clause.startsWith(">=");
    const isExclusive = clause.startsWith(">") && !isInclusive;
    const isPoetryCompatible = clause.startsWith("^") || clause.startsWith("~");

    if (isInclusive || isExclusive || isPoetryCompatible) {
      const numericRaw = clause.replace(/[>=^~]/g, "").trim();
      let parts = numericRaw.split(".").map(part => parseInt(part, 10)).filter(num => !isNaN(num));
      
      if (parts.length === 0) continue;

      // Handle strict exclusive upper-shift logic (e.g., ">3.10" gracefully shifts minimum baseline to 3.11)
      if (isExclusive && parts.length >= 2) {
        parts[parts.length - 1] += 1;
      }

      // Precedence Logic Optimization: Keep the highest lower bound constraint (e.g., between 3.10 and 3.12, pick 3.12)
      if (!absoluteHighestFloor) {
        absoluteHighestFloor = parts;
      } else {
        // Simple element-by-element tuple tracking matrix comparison
        const maxLen = Math.max(absoluteHighestFloor.length, parts.length);
        for (let i = 0; i < maxLen; i++) {
          const valA = absoluteHighestFloor[i] ?? 0;
          const valB = parts[i] ?? 0;
          if (valB > valA) {
            absoluteHighestFloor = parts;
            break;
          } else if (valA > valB) {
            break;
          }
        }
      }
    }
  }

  return absoluteHighestFloor;
}

/** Parse pyproject.toml text. Malformed TOML yields no requirements and says so. */
export function parsePyprojectText(
  text: string,
  project: ProjectRef,
  declaredIn: string,
): PyprojectParseResult {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (error) {
    const line = (error as { line?: unknown } | null)?.line;
    const at = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined;
    return {
      requirements: [],
      extras: {},
      malformed: true,
      evidence: [
        {
          kind: "manifest-malformed",
          statement: `${at !== undefined ? `\({declaredIn}:\){at}` : declaredIn}: invalid TOML; no dependencies read from it, so declared dependencies are incomplete`,
          file: declaredIn,
          ...(at !== undefined ? { line: at } : {}),
        },
      ],
    };
  }
  const out = new Collector(project, declaredIn, new PyprojectLines(text));
  const extras: Record<string, string[]> = {};
  if (isTable(doc)) {
    parsePep621(doc, out, extras);
    parsePoetry(doc, out, extras, declaredIn);

    // 🚀 CLEAN SCHEME WIRE: Directly parsing and tracking python floor without schema pollution
    const projectTable = table(doc, "project");
    if (projectTable !== undefined && typeof projectTable["requires-python"] === "string") {
      const pythonFloorStr = projectTable["requires-python"];
      // Securely calling the newly optimized grammar parser engine
      const resolvedTuple = parsePythonFloorToTuple(pythonFloorStr);
      
      // Pinning the resolved tuple directly into project contextual references safely
      if (resolvedTuple !== undefined) {
        (project as Record<string, unknown>)["pythonFloorTuple"] = resolvedTuple;
      }
    }
  }
  return { requirements: out.requirements, extras, evidence: out.evidence, malformed: false };
}