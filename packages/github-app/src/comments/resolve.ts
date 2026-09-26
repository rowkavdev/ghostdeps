/**
 * Finding -> declaring Dependency resolution (slice 3). A Finding names a
 * dependency but not its project; the eligibility join MUST include the
 * project dimension or one project's eligibility bleeds onto another's
 * same-named declaration (reviewer-1 #425). Ambiguity fails closed: an
 * unresolved finding is explanation-only, never tickable.
 */
import type { AnalysisResult, Dependency, Finding } from "@ghostdeps/core";

export type FindingDeclaration =
  | { readonly status: "resolved"; readonly dependency: Dependency }
  | { readonly status: "ambiguous" }
  | { readonly status: "missing" };

export function resolveFindingDeclaration(
  result: AnalysisResult,
  finding: Finding,
): FindingDeclaration {
  const matches = (result.dependencies ?? []).filter((d) => d.name === finding.dependency);
  if (matches.length === 0) return { status: "missing" };
  // Multiple projects (or a project plus a re-declaration) with the same
  // name: never guess which declaration the finding means.
  const keys = new Set(matches.map((d) => `${d.project.path}	${d.declaredIn}	${d.kind}`));
  if (matches.length > 1 && keys.size > 1) return { status: "ambiguous" };
  return { status: "resolved", dependency: matches[0]! };
}

/** `rule:projectPath:dependency` - the eligibility map key, project-scoped. */
export function eligibilityId(rule: string, projectPath: string, dependency: string): string {
  return `${rule}:${projectPath}:${dependency}`;
}
