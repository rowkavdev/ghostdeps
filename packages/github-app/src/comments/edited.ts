/**
 * issue_comment.edited validation (design #3-#4), slice-3 gated scope:
 * validate the edit and enforce the canonical body - no dispatch, no apply.
 *
 * A valid tick differs from the previous canonical body ONLY in `[ ]` -> `[x]`
 * flips on checkbox lines carrying a tickable key from the marker. Anything
 * else (added lines, changed text, unchecks, forged keys, reordered content)
 * restores the canonical body. A valid tick in slice 3 restores the body too
 * and leaves a visible note: the trusted apply workflow is slice 4 and no
 * installation has it enabled yet. No edit is ever treated as authority on
 * its own: the actor's CURRENT repository permission is read live.
 */
import { parseMarker } from "./marker.js";
import { commentLockKey, withCommentLock } from "./queue.js";
import type { IssuesClient } from "./state.js";

/** Repos collaborator-permission slice; minted read-only for the check. */
export interface PermissionClient {
  repos: {
    getCollaboratorPermissionLevel(params: {
      owner: string;
      repo: string;
      username: string;
    }): Promise<{ data: { permission: string } }>;
  };
}

const TICK_LINE_RE = /^- \[([ x])\] .+ <!-- gd-key:([0-9a-f]{64}) -->$/;
/** Maintainer-only ticks (Rowan's rule): admin or maintain, never mere write. */
const TICK_PERMISSIONS = new Set(["admin", "maintain"]);
const MAX_BODY_BYTES = 65_536;
const MAX_BODY_LINES = 500;

export interface EditedPayload {
  readonly action: string;
  readonly issue: { number: number; pull_request?: unknown };
  readonly comment: {
    id: number;
    body: string;
    user?: { login?: string; type?: string } | null;
  };
  readonly changes?: { body?: { from?: string } };
  readonly repository: { id: number; owner: { login: string }; name: string };
  readonly sender: { login: string };
  readonly installation?: { id: number; suspended_at?: string | null };
}

export type EditOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "restored"; readonly tickedKeys: readonly string[] };

/** The canonical body is the delivery's `from` body once it parses as ours. */
function canonicalFrom(from: string | undefined): string | undefined {
  if (from === undefined || Buffer.byteLength(from) > MAX_BODY_BYTES) return undefined;
  if (from.split("\n").length > MAX_BODY_LINES) return undefined;
  return parseMarker(from) ? from : undefined;
}

/**
 * Diff `from` -> `to`. Returns the ticked keys when the ONLY differences are
 * `[ ]` -> `[x]` flips on gd-key lines whose key is in allowedKeys, line for
 * line; otherwise undefined. Unchecks and any other byte change reject.
 */
export function checkboxOnlyDiff(
  from: string,
  to: string,
  allowedKeys: ReadonlySet<string>,
): string[] | undefined {
  if (Buffer.byteLength(to) > MAX_BODY_BYTES) return undefined;
  const a = from.split("\n");
  const b = to.split("\n");
  if (a.length !== b.length || a.length > MAX_BODY_LINES) return undefined;
  const ticked: string[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    const before = TICK_LINE_RE.exec(a[i]!);
    const after = TICK_LINE_RE.exec(b[i]!);
    // Same line, same key, and strictly an unticked -> ticked flip.
    if (!before || !after || before[2] !== after[2]) return undefined;
    if (before[1] !== " " || after[1] !== "x") return undefined;
    if (before[2] !== undefined && !allowedKeys.has(before[2])) return undefined;
    // The non-checkbox bytes of the line must be identical.
    if (a[i]!.replace("[ ]", "[x]") !== b[i]) return undefined;
    ticked.push(before[2]!);
  }
  return ticked.length === 0 ? [] : ticked;
}

export interface HandleEditedDeps {
  readonly issues: IssuesClient;
  readonly permissions: PermissionClient;
  readonly botLogin: string;
  readonly log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export async function handleCommentEdited(
  deps: HandleEditedDeps,
  payload: EditedPayload,
): Promise<EditOutcome> {
  const ignore = (reason: string): EditOutcome => ({ kind: "ignored", reason });
  if (payload.action !== "edited") return ignore("not an edited delivery");
  if (!payload.issue.pull_request) return ignore("not a pull request comment");
  if (payload.installation?.suspended_at) return ignore("installation suspended");
  if (payload.comment.user?.login !== deps.botLogin) return ignore("not our comment");
  if (payload.comment.user?.type !== "Bot") return ignore("author is not a bot");

  const marker = parseMarker(payload.comment.body);
  const fromMarker = parseMarker(payload.changes?.body?.from ?? "");
  if (!marker || !fromMarker) return ignore("no valid marker");
  if (
    marker.repositoryId !== payload.repository.id ||
    marker.pullNumber !== payload.issue.number ||
    fromMarker.repositoryId !== marker.repositoryId ||
    fromMarker.pullNumber !== marker.pullNumber ||
    fromMarker.headSha !== marker.headSha
  ) {
    return ignore("marker does not match this repository, PR and scan");
  }

  const canonical = canonicalFrom(payload.changes?.body?.from);
  if (canonical === undefined) return ignore("previous body is not canonical");

  // Serialised with the scan writer (queue.ts, lead ruling
  // issuecomment-5847830199): the whole read-modify-write below runs
  // inside the per-PR writer lock, so no scan render can interleave
  // between these reads and the write. The live re-reads stay as defense
  // against out-of-band actors (a human editing this instant, another
  // replica); they narrow that window but cannot eliminate it.
  return withCommentLock(commentLockKey(payload.repository.id, payload.issue.number), () =>
    handleCommentEditedLocked(deps, payload, marker, canonical, ignore),
  );
}

async function handleCommentEditedLocked(
  deps: HandleEditedDeps,
  payload: EditedPayload,
  marker: NonNullable<ReturnType<typeof parseMarker>>,
  canonical: string,
  ignore: (reason: string) => EditOutcome,
): Promise<EditOutcome> {
  // Re-read live state before ANY edit (reviewer-1 #425): a delayed delivery
  // must never overwrite a newer canonical comment, and a restore onto a
  // closed or merged PR is wrong. The delivery's claim is not state.
  const readLive = async (): Promise<{ body: string | undefined; prOpen: boolean } | undefined> => {
    try {
      const [comment, issue] = await Promise.all([
        deps.issues.issues.getComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          comment_id: payload.comment.id,
        }),
        deps.issues.issues.get({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          issue_number: payload.issue.number,
        }),
      ]);
      return {
        body: comment.data.body ?? undefined,
        prOpen: issue.data.state === "open" && issue.data.pull_request !== undefined,
      };
    } catch {
      return undefined;
    }
  };

  const first = await readLive();
  if (first === undefined) return ignore("current comment or PR state could not be read");
  if (!first.prOpen) return ignore("pull request is not open");
  if (first.body !== payload.comment.body)
    return ignore("comment moved after this delivery; a newer delivery owns it");

  // Live permission read: association labels and the checkbox UI prove
  // nothing; only the repository's current answer counts.
  let permission: string;
  try {
    const { data } = await deps.permissions.repos.getCollaboratorPermissionLevel({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      username: payload.sender.login,
    });
    permission = data.permission;
  } catch {
    return ignore("editor permission could not be verified");
  }
  if (!TICK_PERMISSIONS.has(permission)) return ignore(`editor is ${permission}, not a maintainer`);

  // The permission call above is a window in which an out-of-band actor
  // can replace the comment. Re-read immediately before writing and refuse
  // unless the live body is still exactly what this delivery showed.
  const still = await readLive();
  if (still === undefined) return ignore("current comment or PR state could not be read");
  if (!still.prOpen) return ignore("pull request is not open");
  if (still.body !== payload.comment.body)
    return ignore("comment moved while permissions were checked; refusing to overwrite");

  const allowed = new Set(marker.keys);
  const ticked = checkboxOnlyDiff(canonical, payload.comment.body, allowed);
  if (ticked === undefined) {
    // Tampered or accidental edit: put the canonical body back.
    await deps.issues.issues.updateComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      comment_id: payload.comment.id,
      body: canonical,
    });
    deps.log.warn({ comment: payload.comment.id }, "non-checkbox edit reverted to canonical");
    return { kind: "restored", tickedKeys: [] };
  }

  // Valid tick(s), but slice 3 has no dispatch: restore the canonical body
  // with a visible note so nothing looks applied or silently swallowed.
  const note =
    ticked.length === 0
      ? ""
      : `\n\n_${ticked.length} removal${ticked.length === 1 ? "" : "s"} ticked by a maintainer - tick-to-apply is not enabled yet, so nothing was changed. The trusted workflow ships separately._`;
  await deps.issues.issues.updateComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    comment_id: payload.comment.id,
    body: `${canonical}${note}`,
  });
  deps.log.info(
    { comment: payload.comment.id, ticked: ticked.length },
    "maintainer tick acknowledged; apply not enabled",
  );
  return { kind: "restored", tickedKeys: ticked };
}
