import { DECLARATION_ANCHORED_RULES, DECLARATION_EVIDENCE_KINDS } from "../recommend/policy.js";
import type { Dependency, Finding, RepositoryHandle } from "../types/index.js";

/** At most this many distinct manifests are read to verify lines. */
export const MAX_VERIFIED_MANIFESTS = 1000;
/** Manifests larger than this (UTF-16 code units) are not line-verified. */
export const MAX_VERIFIED_MANIFEST_CHARS = 2_000_000;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** PEP 503 normalised name: lowercase, runs of `-`, `_` and `.` become one `-`. */
export const pep503 = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * Python (#286): the line has a name-like token that is the same package
 * under PEP 503, e.g. `PyYAML` declared and `pyyaml>=6` on the line, or
 * `typing_extensions` and `typing-extensions`. Only adds line precision;
 * never changes a verdict (ADR 0004).
 */
function hasPep503Token(text: string, name: string): boolean {
  const wanted = pep503(name);
  for (const token of text.match(/[A-Za-z0-9._-]+/g) ?? []) {
    if (pep503(token) === wanted) return true;
  }
  return false;
}

/**
 * Keep an adapter's `declaredLine` (#198) only if that line of the manifest
 * contains the dependency name as a whole token (for python, the same name
 * under PEP 503 normalisation, #286). Adapter output is
 * untrusted: a non-integer, out-of-range or mismatched line is dropped,
 * never guessed or corrected. Each manifest is read once, and reads are
 * capped (MAX_VERIFIED_MANIFESTS, MAX_VERIFIED_MANIFEST_CHARS): past a cap
 * the line is dropped and the declaration-line note counts it.
 */
export async function verifyDeclaredLines(
  repository: RepositoryHandle,
  dependencies: readonly Dependency[],
): Promise<Dependency[]> {
  const manifests = new Map<string, Promise<string[] | undefined>>();
  const linesOf = (file: string): Promise<string[] | undefined> => {
    if (!manifests.has(file)) {
      if (manifests.size >= MAX_VERIFIED_MANIFESTS) return Promise.resolve(undefined);
      manifests.set(
        file,
        repository.readFile(file).then(
          (text) => (text.length > MAX_VERIFIED_MANIFEST_CHARS ? undefined : text.split(/\r?\n/)),
          () => undefined,
        ),
      );
    }
    return manifests.get(file)!;
  };

  return Promise.all(
    dependencies.map(async (dep) => {
      if (dep.declaredLine === undefined) return dep;
      const line = dep.declaredLine;
      const { declaredLine: _dropped, ...without } = dep;
      void _dropped;
      if (!Number.isInteger(line) || line < 1 || typeof dep.name !== "string") return without;
      const text = (await linesOf(dep.declaredIn))?.[line - 1];
      if (text === undefined) return without;
      const token = new RegExp(`(^|[^A-Za-z0-9._/@-])${escape(dep.name)}([^A-Za-z0-9._/-]|$)`);
      if (token.test(text)) return dep;
      return dep.project?.ecosystem === "python" && hasPep503Token(text, dep.name) ? dep : without;
    }),
  );
}

/**
 * One run note when declaration-anchored findings (#198) could only point
 * at the manifest file, not the declaration line (cap-and-note, #154).
 */
export function declarationLineNote(findings: readonly Finding[]): Finding | undefined {
  const fileOnly = findings.filter(
    (f) =>
      f.rule !== undefined &&
      DECLARATION_ANCHORED_RULES.has(f.rule) &&
      f.evidence.some(
        (e) =>
          DECLARATION_EVIDENCE_KINDS.has(e.kind) && e.file !== undefined && e.line === undefined,
      ),
  ).length;
  if (fileOnly === 0) return undefined;
  return {
    kind: "info",
    rule: "declaration-line-unavailable",
    summary: `declaration line unavailable for ${fileOnly} finding(s); they point at the manifest file only`,
    recommendation:
      "The adapter for this ecosystem did not report a verifiable declaration line. Look for the dependency in the named manifest.",
    evidence: [
      {
        kind: "declaration-line-unavailable",
        statement: `${fileOnly} declaration-anchored finding(s) carry a file but no line`,
      },
    ],
    confidence: "high",
    limitations: [],
    affectedFiles: [],
  };
}
