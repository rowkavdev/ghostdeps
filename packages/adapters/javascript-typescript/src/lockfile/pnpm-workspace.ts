/**
 * pnpm workspace membership (#894). A pnpm lockfile lists one importer per
 * workspace member, so a project below the lockfile's directory that is not
 * matched by pnpm-workspace.yaml `packages` is simply not covered by it - not
 * a stale lockfile. Only simple glob segments are understood (`*`, `?`,
 * `**`, literals, `!` negation); anything else leaves membership unknown, and
 * the caller reports a limitation instead of guessing.
 */
import { parse } from "yaml";
import type { AdapterContext } from "@ghostdeps/core";

export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;

export type Membership =
  { kind: "member" } | { kind: "nonmember" } | { kind: "unknown"; reason: string };

const SIMPLE_SEGMENT = /^[^[\]{}()!+@|\\]+$/u;

/** Wildcards match Unicode code points, without regex backtracking. */
function matchSegment(pattern: string[], path: string[]): boolean {
  let next = new Uint8Array(path.length + 1);
  next[path.length] = 1;
  for (let p = pattern.length - 1; p >= 0; p--) {
    const current = new Uint8Array(path.length + 1);
    const char = pattern[p]!;
    if (char === "*") {
      current[path.length] = next[path.length]!;
      for (let j = path.length - 1; j >= 0; j--) current[j] = next[j] || current[j + 1] ? 1 : 0;
    } else {
      for (let j = path.length - 1; j >= 0; j--) {
        current[j] = next[j + 1] && (char === "?" || char === path[j]) ? 1 : 0;
      }
    }
    next = current;
  }
  return next[0] === 1;
}

/** Cap repository-controlled matching work; an over-budget result is unknown. */
const MAX_MATCH_STATES = 100_000;

/** Whether matching stays inside the work budget, counting character work too. */
function withinBudget(pattern: string[], patternChars: string[][], pathChars: string[][]): boolean {
  const segmentStates = (pattern.length + 1) * (pathChars.length + 1);
  if (segmentStates > MAX_MATCH_STATES) return false;
  const patternWork = patternChars.reduce(
    (sum, chars, i) => sum + (pattern[i] === "**" ? 0 : chars.length + 1),
    0,
  );
  const pathWork = pathChars.reduce((sum, chars) => sum + chars.length + 1, 0);
  return patternWork * pathWork + segmentStates <= MAX_MATCH_STATES;
}

function globstarRow(next: Uint8Array, path: string[], dot: boolean): Uint8Array {
  const current = new Uint8Array(path.length + 1);
  current[path.length] = next[path.length]!;
  for (let j = path.length - 1; j >= 0; j--) {
    current[j] = next[j] || ((dot || !path[j]!.startsWith(".")) && current[j + 1]) ? 1 : 0;
  }
  return current;
}

function segmentRow(
  next: Uint8Array,
  head: string,
  headChars: string[],
  path: string[],
  pathChars: string[][],
  dot: boolean,
): Uint8Array {
  const current = new Uint8Array(path.length + 1);
  for (let j = path.length - 1; j >= 0; j--) {
    const dotOk = dot || !path[j]!.startsWith(".") || head.startsWith(".");
    current[j] = next[j + 1] && dotOk && matchSegment(headChars, pathChars[j]!) ? 1 : 0;
  }
  return current;
}

/** `**` matches zero or more whole segments; other segments match one. */
function matchSegments(pattern: string[], path: string[], dot: boolean): boolean | undefined {
  const patternChars = pattern.map((segment) => Array.from(segment));
  const pathChars = path.map((segment) => Array.from(segment));
  if (!withinBudget(pattern, patternChars, pathChars)) return undefined;
  // Bottom-up dynamic programming visits each (pattern, path) suffix once.
  // Two rows avoid recursive stack growth and repeated globstar backtracking.
  let next: Uint8Array = new Uint8Array(path.length + 1);
  next[path.length] = 1;
  for (let p = pattern.length - 1; p >= 0; p--) {
    const head = pattern[p]!;
    next =
      head === "**"
        ? globstarRow(next, path, dot)
        : segmentRow(next, head, patternChars[p]!, path, pathChars, dot);
  }
  return next[0] === 1;
}

function normalisePattern(raw: string): string[] {
  return raw
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

function unsupportedReason(raw: string, body: string, segments: string[]): string | undefined {
  if (/^(\/|\\|[A-Za-z]:)/.test(body) || segments.includes("..")) {
    return `absolute or parent glob "${raw}"`;
  }
  // A literal dot segment next to `**` is where tinyglobby's behaviour is subtle; don't guess.
  if (segments.includes("**") && segments.some((x) => x.startsWith("."))) {
    return `dot segment combined with ** in "${raw}"`;
  }
  if (!segments.every((x) => x === "**" || SIMPLE_SEGMENT.test(x)))
    return `unsupported glob "${raw}"`;
  return undefined;
}

/** Whether `rel` (posix, relative to the workspace root) is a member per `patterns`. */
export function matchWorkspacePatterns(patterns: string[], rel: string): Membership {
  const path = rel.split("/").filter((s) => s !== "" && s !== ".");
  // pnpm's isWorkspaceProjectDir rejects any node_modules or bower_components segment outright.
  if (path.some((x) => x === "node_modules" || x === "bower_components")) {
    return { kind: "nonmember" };
  }
  let included = false;
  let excluded = false;
  // pnpm matches negated patterns with dot:true but includes with dot:false, and tinyglobby's own
  // ignore handling differs again. A dot-segment include next to any exclusion is unproven: don't guess.
  const dotInclude = patterns.some(
    (p) => !p.startsWith("!") && normalisePattern(p).some((x) => x.startsWith(".")),
  );
  if (dotInclude && patterns.some((p) => p.startsWith("!"))) {
    return { kind: "unknown", reason: "dot-segment pattern combined with an exclusion" };
  }
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    const segments = normalisePattern(body);
    const unsupported = unsupportedReason(raw, body, segments);
    if (unsupported) return { kind: "unknown", reason: unsupported };
    const matches = matchSegments(segments, path, negated);
    if (matches === undefined) {
      return { kind: "unknown", reason: "workspace glob matching exceeds the work limit" };
    }
    if (matches) {
      if (negated) excluded = true;
      else included = true;
    }
  }
  // Like tinyglobby, which pnpm uses: a negated pattern excludes whatever it matches, in any order.
  return { kind: included && !excluded ? "member" : "nonmember" };
}

/** Membership of `rel` in the pnpm workspace rooted at `rootDir`, from its pnpm-workspace.yaml. */
export async function pnpmWorkspaceMembership(
  context: AdapterContext,
  rootDir: string,
  rel: string,
): Promise<Membership> {
  const file =
    rootDir === "." || rootDir === "" ? "pnpm-workspace.yaml" : `${rootDir}/pnpm-workspace.yaml`;
  let text: string;
  try {
    if (!(await context.repository.exists(file))) {
      return { kind: "unknown", reason: `${file} was not found` };
    }
    text = await context.repository.readFile(file);
  } catch {
    return { kind: "unknown", reason: `${file} could not be read` };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_WORKSPACE_FILE_BYTES) {
    return { kind: "unknown", reason: `${file} is too large to read` };
  }
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 100, uniqueKeys: true });
  } catch {
    return { kind: "unknown", reason: `${file} could not be parsed` };
  }
  const packages =
    typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).packages : undefined;
  if (!Array.isArray(packages) || packages.some((p) => typeof p !== "string")) {
    return { kind: "unknown", reason: `${file} has no packages list` };
  }
  return matchWorkspacePatterns(packages as string[], rel);
}
