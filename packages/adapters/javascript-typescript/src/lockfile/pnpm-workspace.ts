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

function segmentRegExp(segment: string): RegExp {
  const source = segment
    .split("")
    .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.^$]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "u");
}

/** `**` matches zero or more whole segments; other segments match one. */
function matchSegments(pattern: string[], path: string[], dot: boolean): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(rest, path.slice(i), dot)) return true;
      if (!dot && path[i]?.startsWith(".")) return false; // `**` never crosses a dot segment
    }
    return false;
  }
  if (path.length === 0) return false;
  // Without `dot: true` (pnpm's tinyglobby call) wildcards skip dot segments; a literal "." prefix still matches.
  if (!dot && path[0]!.startsWith(".") && !head!.startsWith(".")) return false;
  return segmentRegExp(head!).test(path[0]!) && matchSegments(rest, path.slice(1), dot);
}

function normalisePattern(raw: string): string[] {
  return raw
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
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
    if (/^(\/|\\|[A-Za-z]:)/.test(body) || segments.includes("..")) {
      return { kind: "unknown", reason: `absolute or parent glob "${raw}"` };
    }
    // A literal dot segment next to `**` is where tinyglobby's behaviour is subtle; don't guess.
    if (segments.includes("**") && segments.some((x) => x.startsWith("."))) {
      return { kind: "unknown", reason: `dot segment combined with ** in "${raw}"` };
    }
    if (!segments.every((s) => s === "**" || SIMPLE_SEGMENT.test(s))) {
      return { kind: "unknown", reason: `unsupported glob "${raw}"` };
    }
    if (matchSegments(segments, path, negated)) {
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
