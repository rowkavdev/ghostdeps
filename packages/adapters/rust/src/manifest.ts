/**
 * Cargo.toml -> Dependency parser (issue #49).
 *
 * Covers [dependencies], [dev-dependencies], [build-dependencies] (plus the
 * legacy underscore spellings), target-specific tables
 * ([target.'cfg(..)'.dependencies]), renamed dependencies (`package = ".."`),
 * path/git/alternative-registry specifiers and workspace inheritance
 * (`{ workspace = true }` resolved against [workspace.dependencies]).
 *
 * Feature flags: the Dependency contract has no feature field, so
 * feature-conditional dependencies are represented as kind "optional"
 * (Cargo only allows `optional` on normal and build dependencies; an
 * optional build dependency keeps kind "build") plus one
 * "feature-gated-dependency" evidence entry naming the features that enable
 * it. Target-specific dependencies get a "target-conditional-dependency"
 * evidence entry. Both are facts; policy decides what they mean.
 */
import type { Dependency, DependencyKind, Evidence, ProjectRef } from "@ghostdeps/core";
import { isTable, stringArray, type CargoManifest, type TomlTable } from "./cargo-toml.js";
import { compareStrings } from "./paths.js";

export interface ManifestParseResult {
  dependencies: Dependency[];
  /** Feature- and target-conditional facts about the dependencies. */
  conditions: Evidence[];
  /** Problems found while parsing; empty when the manifest was clean. */
  errors: Evidence[];
}

const TABLES: readonly (readonly [string, DependencyKind])[] = [
  ["dependencies", "runtime"],
  ["dev-dependencies", "dev"],
  ["dev_dependencies", "dev"],
  ["build-dependencies", "build"],
  ["build_dependencies", "build"],
];

type Specifier = NonNullable<Dependency["specifier"]>;

interface Declared {
  key: string;
  name: string;
  constraint: string;
  optional: boolean;
  specifier?: Specifier;
}

/** Interpret one dependency entry. Undefined (plus an error) when unusable. */
function interpret(
  key: string,
  value: unknown,
  inherited: TomlTable | undefined,
  file: string,
  errors: Evidence[],
): Declared | undefined {
  if (typeof value === "string") {
    return value.length > 0
      ? { key, name: key, constraint: value, optional: false }
      : invalid(key, file, errors, "has an empty version");
  }
  if (!isTable(value)) return invalid(key, file, errors, "is neither a version string nor a table");

  let entry: TomlTable = value;
  if (value.workspace === true) {
    const base = inherited?.[key];
    if (base === undefined) {
      return invalid(
        key,
        file,
        errors,
        "inherits from the workspace but [workspace.dependencies] has no entry",
      );
    }
    const baseTable: TomlTable =
      typeof base === "string" ? { version: base } : isTable(base) ? base : {};
    // Members may add features and `optional`; everything else comes from the root.
    const features = [...stringArray(baseTable.features), ...stringArray(value.features)];
    entry = { ...baseTable, features };
    if (value.optional !== undefined) entry.optional = value.optional;
  }

  const name = typeof entry.package === "string" && entry.package.length > 0 ? entry.package : key;
  const version =
    typeof entry.version === "string" && entry.version.length > 0 ? entry.version : undefined;
  let specifier: Specifier | undefined;
  if (typeof entry.path === "string") {
    specifier = { type: "file", detail: entry.path };
  } else if (typeof entry.git === "string") {
    const ref = ["rev", "tag", "branch"]
      .filter((k) => typeof entry[k] === "string")
      .map((k) => `${k}=${String(entry[k])}`);
    specifier = { type: "git", detail: [entry.git, ...ref].join(" ") };
  } else if (typeof entry.registry === "string") {
    specifier = { type: "registry", detail: `registry: ${entry.registry}` };
  }
  if (version === undefined && specifier === undefined) {
    return invalid(key, file, errors, "has no version, path or git source");
  }
  const declared: Declared = {
    key,
    name,
    constraint: version ?? "*",
    optional: entry.optional === true,
  };
  if (specifier !== undefined) declared.specifier = specifier;
  return declared;
}

function invalid(key: string, file: string, errors: Evidence[], why: string): undefined {
  errors.push({
    kind: "dependency-malformed",
    statement: `dependency "${key}" in ${file} ${why}; skipped`,
    file,
  });
  return undefined;
}

/**
 * Which features enable each optional dependency key. An optional
 * dependency `foo` is enabled by `dep:foo`, `foo/<feat>` (which also turns
 * `foo` on), and - unless some feature uses `dep:foo` - the implicit
 * feature `foo`. `foo?/<feat>` only forwards a feature and never enables it.
 */
export function featureGates(
  document: TomlTable,
  optionalKeys: ReadonlySet<string>,
): Map<string, string[]> {
  const gates = new Map<string, Set<string>>();
  const features = isTable(document.features) ? document.features : {};
  const explicitDep = new Set<string>();
  for (const [feature, entries] of Object.entries(features)) {
    for (const item of stringArray(entries)) {
      let key: string | undefined;
      if (item.startsWith("dep:")) {
        key = item.slice(4);
        explicitDep.add(key);
      } else if (item.includes("/")) {
        const head = item.slice(0, item.indexOf("/"));
        if (!head.endsWith("?")) key = head;
      } else if (optionalKeys.has(item)) {
        key = item;
      }
      if (key !== undefined && optionalKeys.has(key)) {
        if (!gates.has(key)) gates.set(key, new Set());
        gates.get(key)!.add(feature);
      }
    }
  }
  for (const key of optionalKeys) {
    if (!gates.has(key)) gates.set(key, new Set());
    if (!explicitDep.has(key)) gates.get(key)!.add(key);
  }
  const defaults = new Set(stringArray(features.default));
  return new Map(
    [...gates].map(([key, set]) => [
      key,
      [...set].sort(
        (a, b) => Number(defaults.has(b)) - Number(defaults.has(a)) || compareStrings(a, b),
      ),
    ]),
  );
}

/** Parse one crate manifest. `workspaceRoot` supplies [workspace.dependencies] for inheritance. */
export function parseCargoManifest(
  manifest: CargoManifest,
  project: ProjectRef,
  workspaceRoot?: CargoManifest,
): ManifestParseResult {
  const errors: Evidence[] = [];
  const conditions: Evidence[] = [];
  const dependencies: Dependency[] = [];
  const document = manifest.document;
  if (document === undefined) {
    return { dependencies, conditions, errors: manifest.error ? [manifest.error] : [] };
  }
  const ws = workspaceRoot?.document?.workspace;
  const inherited = isTable(ws) && isTable(ws.dependencies) ? ws.dependencies : undefined;

  const sections: { table: TomlTable; kind: DependencyKind; target?: string }[] = [];
  for (const [field, kind] of TABLES) {
    const table = document[field];
    if (isTable(table)) sections.push({ table, kind });
  }
  if (isTable(document.target)) {
    for (const [target, spec] of Object.entries(document.target)) {
      if (!isTable(spec)) continue;
      for (const [field, kind] of TABLES) {
        const table = spec[field];
        if (isTable(table)) sections.push({ table, kind, target });
      }
    }
  }

  const optionalKeys = new Set<string>();
  const parsed: { declared: Declared; kind: DependencyKind; target?: string }[] = [];
  for (const section of sections) {
    for (const [key, value] of Object.entries(section.table)) {
      const declared = interpret(key, value, inherited, manifest.path, errors);
      if (declared === undefined) continue;
      if (declared.optional && section.kind !== "dev") optionalKeys.add(key);
      parsed.push({
        declared,
        kind: section.kind,
        ...(section.target ? { target: section.target } : {}),
      });
    }
  }

  const gates = featureGates(document, optionalKeys);
  const seen = new Set<string>();
  for (const { declared, kind: tableKind, target } of parsed) {
    const kind: DependencyKind =
      declared.optional && tableKind === "runtime" ? "optional" : tableKind;
    const dedupe = `${declared.name}\0${kind}\0${target ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const dependency: Dependency = {
      name: declared.name,
      constraint: declared.constraint,
      kind,
      project,
      declaredIn: manifest.path,
    };
    if (declared.specifier !== undefined) dependency.specifier = declared.specifier;
    dependencies.push(dependency);

    const renamed = declared.key !== declared.name ? ` (imported as "${declared.key}")` : "";
    if (declared.optional && tableKind !== "dev") {
      const features = gates.get(declared.key) ?? [];
      conditions.push({
        kind: "feature-gated-dependency",
        statement:
          features.length > 0
            ? `${declared.name}${renamed} is optional; enabled by feature${features.length > 1 ? "s" : ""}: ${features.join(", ")}`
            : `${declared.name}${renamed} is optional and no feature enables it`,
        file: manifest.path,
      });
    }
    if (target !== undefined) {
      conditions.push({
        kind: "target-conditional-dependency",
        statement: `${declared.name}${renamed} is only used for target ${target}`,
        file: manifest.path,
      });
    }
  }
  return { dependencies, conditions, errors };
}
