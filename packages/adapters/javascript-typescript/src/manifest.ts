/**
 * package.json -> Dependency parser (issue #26). Manifests are untrusted
 * input (security-model rule 3): malformed JSON, non-object documents and
 * non-string constraints produce evidence entries, never exceptions, and
 * non-registry specifiers (git/file/link/workspace) are recorded, never
 * executed.
 */
import { scanDeclaredLines } from "./declared-lines.js";
import type {
  Dependency,
  DependencyKind,
  Evidence,
  ProjectRef,
  RepositoryHandle,
} from "@ghostdeps/core";

export interface ManifestParseResult {
  dependencies: Dependency[];
  /** Problems found while parsing; empty when the manifest was clean. */
  errors: Evidence[];
}

const KIND_BY_FIELD: Readonly<Record<string, DependencyKind>> = {
  dependencies: "runtime",
  devDependencies: "dev",
  peerDependencies: "peer",
  optionalDependencies: "optional",
};

type Specifier = NonNullable<Dependency["specifier"]>;

/**
 * Classify a raw version specifier. Plain semver ranges and dist-tags are
 * registry specifiers and stay unspecified (the default); everything else is
 * recorded with its raw text. Nothing here is ever resolved or executed.
 */
export function classifySpecifier(raw: string): Specifier | undefined {
  if (raw.startsWith("workspace:")) return { type: "workspace", detail: raw };
  if (raw.startsWith("link:")) return { type: "link", detail: raw };
  if (raw.startsWith("file:")) return { type: "file", detail: raw };
  if (
    raw.startsWith("git:") ||
    raw.startsWith("git+") ||
    raw.startsWith("github:") ||
    raw.startsWith("gitlab:") ||
    raw.startsWith("bitbucket:") ||
    raw.startsWith("gist:")
  ) {
    return { type: "git", detail: raw };
  }
  // GitHub shorthand ("user/repo"). Scoped registry names start with "@", so
  // they cannot collide with this shape.
  if (/^[\w][\w.-]*\/[\w][\w.-]*$/.test(raw)) return { type: "git", detail: raw };
  if (raw.startsWith("npm:")) return { type: "registry", detail: `npm alias: ${raw}` };
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    // Direct tarball URL: fetched at install time by the package manager, but
    // never by GhostDeps. Recorded as registry-shaped with the URL preserved.
    return { type: "registry", detail: `tarball URL (never fetched): ${raw}` };
  }
  return undefined; // plain semver range, "*", exact version, or dist-tag
}

export function parseManifestText(
  manifestText: string,
  project: ProjectRef,
  declaredIn: string,
): ManifestParseResult {
  const errors: Evidence[] = [];
  const dependencies: Dependency[] = [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    errors.push({
      kind: "manifest-malformed",
      statement: `${declaredIn} is not valid JSON; no dependencies parsed (confidence degraded, not a crash)`,
      file: declaredIn,
    });
    return { dependencies, errors };
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    errors.push({
      kind: "manifest-malformed",
      statement: `${declaredIn} is not a JSON object; no dependencies parsed`,
      file: declaredIn,
    });
    return { dependencies, errors };
  }

  const record = manifest as Record<string, unknown>;
  const lines = scanDeclaredLines(manifestText, new Set(Object.keys(KIND_BY_FIELD)));
  for (const [field, kind] of Object.entries(KIND_BY_FIELD)) {
    const section = record[field];
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      errors.push({
        kind: "manifest-entry-skipped",
        statement: `${declaredIn}: "${field}" is not an object; section skipped`,
        file: declaredIn,
      });
      continue;
    }
    for (const [name, constraint] of Object.entries(section as Record<string, unknown>)) {
      if (typeof constraint !== "string" || constraint.length === 0) {
        errors.push({
          kind: "manifest-entry-skipped",
          statement: `${declaredIn}: "${name}" in ${field} has no string constraint; entry skipped`,
          file: declaredIn,
        });
        continue;
      }
      const dependency: Dependency = {
        name,
        constraint,
        kind,
        project,
        declaredIn,
      };
      const declaredLine = lines.get(field)?.get(name);
      if (declaredLine !== undefined) dependency.declaredLine = declaredLine;
      const specifier = classifySpecifier(constraint);
      if (specifier !== undefined) dependency.specifier = specifier;
      dependencies.push(dependency);
    }
  }

  return { dependencies, errors };
}

/** Parse the package.json at a project root into the shared Dependency model. */
export async function parseManifest(
  repository: RepositoryHandle,
  project: ProjectRef,
): Promise<ManifestParseResult> {
  const declaredIn = project.path === "." ? "package.json" : `${project.path}/package.json`;
  let text: string;
  try {
    text = await repository.readFile(declaredIn);
  } catch {
    return {
      dependencies: [],
      errors: [
        {
          kind: "manifest-missing",
          statement: `${declaredIn} could not be read; no dependencies parsed`,
          file: declaredIn,
        },
      ],
    };
  }
  return parseManifestText(text, project, declaredIn);
}
