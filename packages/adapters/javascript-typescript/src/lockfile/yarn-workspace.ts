/**
 * Yarn classic workspace packages. Yarn links a dependency to a workspace
 * package instead of installing it when the workspace's name matches and its
 * version satisfies the requested range, and then writes no lock entry for it.
 * A missing lock entry is therefore expected only for such a package. The set
 * is derived from the root `workspaces` globs and the manifests they match;
 * anything that cannot be proven is reported as "unknown", never as absent.
 */
import type { AdapterContext } from "@ghostdeps/core";
import { MAX_WORKSPACE_FILE_BYTES, matchWorkspacePatterns } from "./pnpm-workspace.js";

/** Most candidate workspace manifests read for one lockfile root. */
export const MAX_YARN_WORKSPACE_MANIFESTS = 2_000;

type Tuple = [number, number, number];
type Comparator = { op: ">" | ">=" | "<" | "<=" | "="; v: Tuple };
export type Match = "yes" | "no" | "unknown";

const NUM = "(0|[1-9]\\d*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const PARTIAL = new RegExp(`^(?:${NUM}|[xX*])(?:\\.(?:${NUM}|[xX*]))?(?:\\.(?:${NUM}|[xX*]))?$`);

function cmp(a: Tuple, b: Tuple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function parsePartial(text: string): (number | undefined)[] | undefined {
  const m = PARTIAL.exec(text.replace(/^v/, ""));
  if (!m) return undefined;
  // m[1..3] are the numeric captures; a wildcard leaves its capture undefined.
  const raw = text.replace(/^v/, "").split(".");
  const parts = raw.map((x, i) => (/^[xX*]$/.test(x) ? undefined : Number(m[i + 1])));
  while (parts.length < 3) parts.push(undefined);
  // semver rejects a number after a wildcard ("1.x.3", "*.1").
  for (let i = 1; i < 3; i++) {
    if (parts[i - 1] === undefined && parts[i] !== undefined) return undefined;
  }
  return parts;
}

const lower = (v: Tuple): Comparator => ({ op: ">=", v });
const below = (v: Tuple): Comparator => ({ op: "<", v });

function nextTuple(M: number, mi: number | undefined, pa: number | undefined): Tuple {
  return mi === undefined ? [M + 1, 0, 0] : pa === undefined ? [M, mi + 1, 0] : [M, mi, pa + 1];
}

function caretBounds(M: number, mi: number | undefined, pa: number | undefined): Comparator[] {
  const floor: Tuple = [M, mi ?? 0, pa ?? 0];
  if (M > 0 || mi === undefined) return [lower(floor), below([M + 1, 0, 0])];
  if (mi > 0 || pa === undefined) return [lower(floor), below([0, mi + 1, 0])];
  return [lower(floor), below([0, 0, pa + 1])];
}

function relationalBounds(
  op: string,
  M: number,
  mi: number | undefined,
  pa: number | undefined,
): Comparator[] {
  const floor: Tuple = [M, mi ?? 0, pa ?? 0];
  if (op === ">=") return [lower(floor)];
  if (op === ">") return [lower(nextTuple(M, mi, pa))];
  if (op === "<") return [below(floor)];
  return [below(nextTuple(M, mi, pa))]; // "<="
}

function opBounds(
  op: string,
  M: number,
  mi: number | undefined,
  pa: number | undefined,
): Comparator[] {
  const floor: Tuple = [M, mi ?? 0, pa ?? 0];
  if (op === "" || op === "=") {
    return mi === undefined || pa === undefined
      ? [lower(floor), below(nextTuple(M, mi, pa))]
      : [{ op: "=", v: floor }];
  }
  if (op === "~" || op === "~>") {
    return [lower(floor), below(mi === undefined ? [M + 1, 0, 0] : [M, mi + 1, 0])];
  }
  if (op === "^") return caretBounds(M, mi, pa);
  return relationalBounds(op, M, mi, pa);
}

/** One comparator token as bounds, or undefined when it is not understood. */
function bounds(token: string): Comparator[] | undefined {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return undefined;
  const p = parsePartial(m[2]!);
  if (!p) return undefined;
  const op = m[1] ?? "";
  const [M, mi, pa] = p;
  if (M === undefined) return op === "<" || op === ">" ? [{ op: "<", v: [0, 0, 0] }] : [];
  return opBounds(op, M, mi, pa);
}

/** Build metadata with its text validated, or undefined when it is malformed. */
function stripBuild(t: string): string | undefined {
  let bad = false;
  const out = t.replace(/\+([^\s|]*)/g, (_m, build: string) => {
    if (!/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(build)) bad = true;
    return "";
  });
  return bad ? undefined : out;
}

function checkFull(t: string): boolean {
  return [...t.matchAll(/(\S*?)\+/g)].every((m) => /(^|[^0-9.])\d+\.\d+\.\d+$/.test(m[1]!));
}

/** Text without build metadata, or undefined when the metadata cannot be trusted. */
function withoutBuild(text: string): string | undefined {
  const stripped = checkFull(text) ? stripBuild(text) : undefined;
  if (stripped === undefined && text.includes("+")) return undefined;
  return stripped ?? text;
}

function parseVersion(version: string): Tuple | undefined {
  const text = withoutBuild(version.trim());
  if (text === undefined) return undefined;
  const v = VERSION.exec(text.replace(/^v/, ""));
  return v ? [Number(v[1]), Number(v[2]), Number(v[3])] : undefined;
}

function holds(have: Tuple, { op, v }: Comparator): boolean {
  const c = cmp(have, v);
  if (op === "=") return c === 0;
  if (op === ">=") return c >= 0;
  if (op === ">") return c > 0;
  if (op === "<") return c < 0;
  return c <= 0;
}

/** The comparators of one `||` alternative, or undefined when any is not understood. */
function setBounds(set: string): Comparator[] | undefined {
  const text = set.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  const tokens = hyphen
    ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
    : text === ""
      ? ["*"]
      : text.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1").split(/\s+/);
  const all: Comparator[] = [];
  for (const token of tokens) {
    const b = bounds(token);
    if (b === undefined) return undefined;
    all.push(...b);
  }
  return all;
}

/**
 * Whether `version` satisfies `range`, for the strict stable subset of npm's
 * range grammar: exact, x-ranges, ^, ~, comparators, hyphen ranges and ||.
 * Build metadata is ignored, as semver does. A prerelease anywhere, a leading
 * zero, a tag, URL or protocol, or any other text is "unknown", never "no".
 */
export function versionSatisfies(version: string, range: string): Match {
  // semver rejects numbers beyond Number.MAX_SAFE_INTEGER and inputs over 256 characters.
  for (const text of [version, range]) {
    if (text.length > 256) return "unknown";
    // Numbers near the safe-integer limit are left to "unknown": semver's own
    // handling of them (and of their increments) is not reproduced here.
    if (/\d{16,}/.test(text)) return "unknown";
  }
  // Build metadata is ignored by semver, but only when it is well formed and
  // follows a full MAJOR.MINOR.PATCH; validate before stripping.
  const have = parseVersion(version);
  if (!have) return "unknown";
  const strippedRange = withoutBuild(range);
  if (strippedRange === undefined) return "unknown";
  let matched = false;
  for (const set of strippedRange.split("||")) {
    const all = setBounds(set);
    // One unreadable alternative makes the whole range unreadable to semver.
    if (!all) return "unknown";
    if (all.every((c) => holds(have, c))) matched = true;
  }
  return matched ? "yes" : "no";
}

/** What the root `workspaces` globs prove about a package name. */
export interface WorkspaceInfo {
  /** Matching members' versions by package name. */
  readonly members: ReadonlyMap<string, string[]>;
  /** Versions of directories whose glob membership is unproven, by name. */
  readonly maybe: ReadonlyMap<string, string[]>;
  /** True when membership could not be established for the whole workspace. */
  readonly uncertain: boolean;
}

export const NO_WORKSPACES: WorkspaceInfo = {
  members: new Map(),
  maybe: new Map(),
  uncertain: false,
};

/** "yes": a workspace fulfils it. "unknown": cannot tell. "no": provably not a workspace. */
export function workspaceFulfils(info: WorkspaceInfo, name: string, range: string): Match {
  let unknown = info.uncertain;
  for (const [group, definite] of [
    [info.members.get(name), true],
    [info.maybe.get(name), false],
  ] as const) {
    for (const version of group ?? []) {
      const m = versionSatisfies(version, range);
      if (m === "yes" && definite) return "yes";
      if (m !== "no") unknown = true;
    }
  }
  return unknown ? "unknown" : "no";
}

const cache = new WeakMap<AdapterContext, Map<string, Promise<WorkspaceInfo>>>();

/** Workspace packages for the yarn workspace rooted at `rootDir`. */
export function yarnWorkspacePackages(
  context: AdapterContext,
  rootDir: string,
): Promise<WorkspaceInfo> {
  let perRun = cache.get(context);
  if (!perRun) cache.set(context, (perRun = new Map()));
  let found = perRun.get(rootDir);
  if (!found) perRun.set(rootDir, (found = load(context, rootDir)));
  return found;
}

async function readJsonObject(
  context: AdapterContext,
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await context.repository.readFile(file);
    if (Buffer.byteLength(text, "utf8") > MAX_WORKSPACE_FILE_BYTES) return undefined;
    const doc: unknown = JSON.parse(text);
    return typeof doc === "object" && doc !== null && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The root `workspaces` globs, or undefined when they are not a list of strings. */
function workspaceGlobs(declared: unknown): string[] | undefined {
  const patterns = Array.isArray(declared)
    ? declared
    : typeof declared === "object" &&
        declared !== null &&
        Array.isArray((declared as { packages?: unknown }).packages)
      ? (declared as { packages: unknown[] }).packages
      : undefined;
  if (!patterns || patterns.some((p) => typeof p !== "string")) return undefined;
  return patterns as string[];
}

/** Match first, then cap: only candidate directories count against the limit. */
function candidateManifests(
  files: string[],
  prefix: string,
  patterns: string[],
): { file: string; definite: boolean }[] {
  const candidates: { file: string; definite: boolean }[] = [];
  for (const file of files.slice().sort()) {
    if (
      !file.startsWith(prefix) ||
      !file.endsWith("/package.json") ||
      file === `${prefix}package.json`
    )
      continue;
    const dir = file.slice(prefix.length, -"/package.json".length);
    const kind = matchWorkspacePatterns(patterns, dir).kind;
    if (kind !== "nonmember") candidates.push({ file, definite: kind === "member" });
  }
  return candidates;
}

/** Fill `members` and `maybe` from the manifests; true when any could not be read. */
async function collectMembers(
  context: AdapterContext,
  candidates: { file: string; definite: boolean }[],
  members: Map<string, string[]>,
  maybe: Map<string, string[]>,
): Promise<boolean> {
  let readFailed = false;
  for (const { file, definite } of candidates) {
    const doc = await readJsonObject(context, file);
    const name = doc && Object.hasOwn(doc, "name") ? doc.name : undefined;
    const version = doc && Object.hasOwn(doc, "version") ? doc.version : undefined;
    if (typeof name !== "string" || typeof version !== "string") {
      // A member without a usable name/version cannot fulfil anything; an
      // unreadable one might have, so it makes the whole answer unknown.
      if (!doc) readFailed = true;
      continue;
    }
    const target = definite ? members : maybe;
    target.set(name, [...(target.get(name) ?? []), version]);
  }
  return readFailed;
}

async function load(context: AdapterContext, rootDir: string): Promise<WorkspaceInfo> {
  const members = new Map<string, string[]>();
  const maybe = new Map<string, string[]>();
  const uncertain = (): WorkspaceInfo => ({ members, maybe, uncertain: true });
  const prefix = rootDir === "." || rootDir === "" ? "" : `${rootDir}/`;
  const root = await readJsonObject(context, `${prefix}package.json`);
  if (!root) return uncertain();
  const declared = Object.hasOwn(root, "workspaces") ? root.workspaces : undefined;
  if (declared === undefined) return { members, maybe, uncertain: false };
  const patterns = workspaceGlobs(declared);
  if (!patterns) return uncertain();
  let files: string[];
  try {
    files = await context.repository.listFiles();
  } catch {
    return uncertain();
  }
  const candidates = candidateManifests(files, prefix, patterns);
  if (candidates.length > MAX_YARN_WORKSPACE_MANIFESTS) return uncertain();
  const readFailed = await collectMembers(context, candidates, members, maybe);
  return { members, maybe, uncertain: readFailed };
}
