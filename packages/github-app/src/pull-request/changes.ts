/**
 * PR dependency context (#115): fetch the PR diff (base...head compare,
 * which needs only contents: read), read the changed
 * manifests at the base and head SHAs, and hand both to core's
 * extractDependencyChanges. The result feeds core through
 * AnalyseOptions.pullRequestChanges (#128); the app never merges results.
 *
 * Manifests are read as text through the Contents API with the job's
 * repo-scoped token (contents: read) and parsed statically by the JS/TS
 * adapter. Nothing is resolved, installed or executed (ADR 0004).
 */
import {
  addedLines,
  extractDependencyChanges,
  isSafeRepositoryPath,
  parseUnifiedDiff,
  type Dependency,
  type FileDiff,
  type PullRequestDependencyChanges,
  type ReadDeclaredDependencies,
} from "@ghostdeps/core";
import { JS_ECOSYSTEM, parseManifestText } from "@ghostdeps/javascript-typescript";
import type { AddedLines } from "@ghostdeps/checks-renderer";

/** The slice of Octokit needed for the diff and raw file reads. */
export interface PullRequestClient {
  request(
    route: "GET /repos/{owner}/{repo}/compare/{basehead}",
    params: { owner: string; repo: string; basehead: string; mediaType: { format: "diff" } },
  ): Promise<{ data: unknown }>;
  request(
    route: "GET /repos/{owner}/{repo}/contents/{path}",
    params: {
      owner: string;
      repo: string;
      path: string;
      ref: string;
      mediaType: { format: "raw" };
    },
  ): Promise<{ data: unknown }>;
}

export interface PullRequestTarget {
  readonly owner: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
}

/**
 * GitHub stops listing files in a compare at this many; a diff that reaches
 * it may be cut short without an error.
 */
export const GITHUB_COMPARE_FILE_LIMIT = 300;

/**
 * Signs that GitHub cut the diff without saying so (#158 review): the file
 * count hit the compare limit, or a modified text file came back with no
 * hunks (its patch was dropped). Pure renames legitimately have no hunks.
 * A false positive only costs a full analysis instead of a scoped one.
 */
export function silentTruncation(files: readonly FileDiff[]): string | undefined {
  if (files.length >= GITHUB_COMPARE_FILE_LIMIT) {
    return `The diff lists ${files.length} files, GitHub's limit, so it may be incomplete.`;
  }
  const cut = files.find((f) => f.status === "modified" && !f.binary && f.hunks.length === 0);
  if (cut) return "A changed file in the diff had no changes shown, so the diff may be incomplete.";
  return undefined;
}

/** A manifest bigger than this is not read; its changes are reported as unknown. */
export const MAX_MANIFEST_CHARS = 1_000_000;

const empty = (limitation: string): PullRequestDependencyChanges => ({
  changes: [],
  manifestsChanged: [],
  lockfilesChanged: [],
  manifestsWithoutLockfileChange: [],
  changedSourceFiles: [],
  sourceLineChanges: [],
  limitations: [limitation],
});

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;

export interface PullRequestContext {
  readonly dependencyChanges: PullRequestDependencyChanges;
  /** Head-side lines the PR adds, per file, for annotation placement. */
  readonly added: AddedLines;
  /**
   * True when every dependency change was read. Only then may the changes
   * scope the analysis; otherwise a missing change could hide a finding.
   */
  readonly complete: boolean;
  /**
   * Changed paths under the head's excluded fixture roots (#354): counted and
   * bounded examples (sorted, at most 10) for disclosure, never analysed.
   */
  readonly excludedChanged: { readonly count: number; readonly examples: readonly string[] };
}

/** Component-boundary prefix match, the same rule the scanner applies. */
const underRoot = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

/**
 * Head fixture scope applies to both snapshots (#354): every extracted
 * record under excluded roots - dependency changes, manifests, lockfiles,
 * manifests-without-lockfile and source lines - is dropped (it is not
 * analysed at the head, so it must not drive verdicts or removed-last-usage)
 * and disclosed by count with bounded examples. Filtering happens after
 * extraction so an unreadable manifest still marks the result incomplete
 * first. A rename crossing the boundary is excluded on BOTH sides: analysing
 * only the in-scope half of a rename would let the excluded half hide.
 */
function applyFixtureScope(
  result: PullRequestDependencyChanges,
  files: readonly FileDiff[],
  roots: readonly string[],
): { changes: PullRequestDependencyChanges; excluded: { count: number; examples: string[] } } {
  if (roots.length === 0) {
    return { changes: result, excluded: { count: 0, examples: [] } };
  }
  const excludedPaths = new Set<string>();
  const display: string[] = [];
  for (const f of files) {
    const sides = [f.oldPath, f.newPath].filter((p): p is string => p !== undefined);
    const under = sides.filter((p) => underRoot(p, roots));
    if (under.length === 0) continue;
    for (const p of sides) excludedPaths.add(p);
    display.push(under[0]!);
  }
  display.sort();
  const keep = (p: string) => !excludedPaths.has(p);
  return {
    changes: {
      ...result,
      changes: result.changes.filter((c) => keep(c.manifest)),
      manifestsChanged: result.manifestsChanged.filter(keep),
      lockfilesChanged: result.lockfilesChanged.filter((l) => keep(l.path)),
      manifestsWithoutLockfileChange: result.manifestsWithoutLockfileChange.filter(keep),
      changedSourceFiles: result.changedSourceFiles.filter((f) => keep(f.path)),
      sourceLineChanges: result.sourceLineChanges.filter((f) => keep(f.path)),
    },
    excluded: { count: display.length, examples: display.slice(0, 10) },
  };
}

const unavailable = (limitation: string): PullRequestContext => ({
  dependencyChanges: empty(limitation),
  added: new Map(),
  complete: false,
  excludedChanged: { count: 0, examples: [] },
});

export async function pullRequestContext(
  client: PullRequestClient,
  pr: PullRequestTarget,
  scopeRoots: readonly string[] = [],
): Promise<PullRequestContext> {
  let diffText: unknown;
  try {
    ({ data: diffText } = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner: pr.owner,
      repo: pr.repo,
      basehead: `${pr.baseSha}...${pr.headSha}`,
      mediaType: { format: "diff" },
    }));
  } catch (error) {
    // GitHub refuses very large diffs (406); anything else is a plain failure.
    return unavailable(
      statusOf(error) === 406
        ? "GitHub would not return this pull request's diff because it is too large."
        : "The pull request diff could not be fetched.",
    );
  }
  if (typeof diffText !== "string") return unavailable("The pull request diff was not text.");

  const readDeclared: ReadDeclaredDependencies = async (side, manifestPath, file) => {
    // Only package.json is wired today; other manifests are reported as unreadable.
    if (file.ecosystem !== JS_ECOSYSTEM || !/(^|\/)package\.json$/.test(manifestPath)) {
      return undefined;
    }
    let text: unknown;
    try {
      ({ data: text } = await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: pr.owner,
        repo: pr.repo,
        path: manifestPath,
        ref: side === "base" ? pr.baseSha : pr.headSha,
        mediaType: { format: "raw" },
      }));
    } catch {
      return undefined;
    }
    if (typeof text !== "string" || text.length > MAX_MANIFEST_CHARS) return undefined;
    const dir = manifestPath.includes("/")
      ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
      : ".";
    const result = parseManifestText(
      text,
      { path: dir, ecosystem: JS_ECOSYSTEM, packageManagers: [] },
      manifestPath,
    );
    // A malformed manifest means its changes are unknown, not "no dependencies".
    if (result.errors.length > 0) return undefined;
    return result.dependencies satisfies Dependency[];
  };

  const diff = parseUnifiedDiff(diffText);
  const dependencyChanges = await extractDependencyChanges(diff, readDeclared);
  const added = new Map<string, Set<number>>();
  for (const file of diff.files) {
    if (file.newPath === undefined || file.binary || !isSafeRepositoryPath(file.newPath)) continue;
    const lines = new Set(addedLines(file).map((l) => l.line));
    if (lines.size > 0) added.set(file.newPath, lines);
  }
  const truncated = silentTruncation(diff.files);
  if (truncated !== undefined) dependencyChanges.limitations.push(truncated);
  const scoped = applyFixtureScope(dependencyChanges, diff.files, scopeRoots);
  return {
    dependencyChanges: scoped.changes,
    added,
    complete: dependencyChanges.limitations.length === 0,
    excludedChanged: scoped.excluded,
  };
}
