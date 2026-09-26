/**
 * The maintained-comment marker (PR-comment design, "State and event
 * protocol" #1): a versioned hidden locator identifying the app, repository,
 * PR, analysed head SHA and the tickable finding keys. A locator, never an
 * authority token: authorisation comes from live permission reads, and tick
 * state is validated against the canonical body, not the marker alone.
 */
const MARKER_RE =
  /^<!-- ghostdeps-comment:v1 repo:(\d+) pr:(\d+) sha:([0-9a-f]{40}) keys:([0-9a-f,]*) -->$/;

/** Tickable finding keys are core's sha256 keys; a comment never carries more than this. */
export const MAX_MARKER_KEYS = 24;
const KEY_RE = /^[0-9a-f]{64}$/;

export interface CommentMarker {
  readonly repositoryId: number;
  readonly pullNumber: number;
  readonly headSha: string;
  readonly keys: readonly string[];
}

export function buildMarker(marker: CommentMarker): string {
  if (!Number.isInteger(marker.repositoryId) || marker.repositoryId <= 0)
    throw new Error("marker repository id must be a positive integer");
  if (!Number.isInteger(marker.pullNumber) || marker.pullNumber <= 0)
    throw new Error("marker pull number must be a positive integer");
  if (!/^[0-9a-f]{40}$/.test(marker.headSha)) throw new Error("marker sha must be 40 hex chars");
  if (marker.keys.length > MAX_MARKER_KEYS)
    throw new Error(`marker carries at most ${MAX_MARKER_KEYS} keys`);
  for (const key of marker.keys) {
    if (!KEY_RE.test(key)) throw new Error("marker keys are 64-char hex");
  }
  return `<!-- ghostdeps-comment:v1 repo:${marker.repositoryId} pr:${marker.pullNumber} sha:${marker.headSha} keys:${marker.keys.join(",")} -->`;
}

/** Parse the marker from a comment body; undefined when absent or malformed. */
export function parseMarker(body: string): CommentMarker | undefined {
  // Bounded: the marker must be the first line so a forged later copy can
  // never shadow the real one.
  const firstLine = body.split("\n", 1)[0] ?? "";
  if (firstLine.length > 1200) return undefined;
  const m = MARKER_RE.exec(firstLine.trim());
  if (!m) return undefined;
  const keys = m[4] === "" ? [] : m[4]!.split(",");
  if (keys.length > MAX_MARKER_KEYS) return undefined;
  if (new Set(keys).size !== keys.length) return undefined;
  return {
    repositoryId: Number(m[1]),
    pullNumber: Number(m[2]),
    headSha: m[3]!,
    keys,
  };
}
