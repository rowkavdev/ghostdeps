import { DECLARATION_ANCHORED_RULES, DECLARATION_EVIDENCE_KINDS } from "../recommend/policy.js";
import type { Dependency, Finding, RepositoryHandle } from "../types/index.js";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keep an adapter's `declaredLine` (#198) only if that line of the manifest
 * contains the dependency name as a whole token. Adapter output is
 * untrusted: a non-integer, out-of-range or mismatched line is dropped,
 * never guessed or corrected. Each manifest is read once.
 */
export async function verifyDeclaredLines(
  repository: RepositoryHandle,
  dependencies: readonly Dependency[],
): Promise<Dependency[]> {
  const manifests = new Map<string, Promise<string[] | undefined>>();
  const linesOf = (file: string): Promise<string[] | undefined> => {
    if (!manifests.has(file)) {
      manifests.set(
        file,
        repository.readFile(file).then(
          (text) => text.split(/\r?\n/),
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
      return token.test(text) ? dep : without;
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
