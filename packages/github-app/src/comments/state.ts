/**
 * Maintained-comment state (design #2): exactly one GhostDeps comment per
 * PR. Discovery lists comments with bounded pagination and matches BOTH our
 * bot author and a well-formed marker; create only when absent, update in
 * place when the canonical body changed, no-op on an identical render.
 * Multiple matching comments are an ambiguity to repair, never a choice.
 */
import { parseMarker, type CommentMarker } from "./marker.js";

/** The issues slice of Octokit the commenter needs; minted narrowed to issues:write. */
export interface IssuesClient {
  issues: {
    listComments(params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page?: number;
      page?: number;
    }): Promise<{ data: { id: number; body?: string | null; user?: { login?: string } | null }[] }>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { id: number } }>;
    updateComment(params: {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    }): Promise<{ data: { id: number } }>;
  };
}

export type MaintainOutcome =
  | { readonly action: "created"; readonly commentId: number }
  | { readonly action: "updated"; readonly commentId: number }
  | { readonly action: "unchanged"; readonly commentId: number }
  | { readonly action: "ambiguous"; readonly commentIds: readonly number[] };

const MAX_PAGES = 2;
const PER_PAGE = 100;

export interface MaintainInput {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  /** Our bot login (e.g. "ghostdeps[bot]"); a marker without it is not ours. */
  readonly botLogin: string;
  readonly body: string;
  readonly marker: CommentMarker;
}

export async function maintainComment(
  client: IssuesClient,
  input: MaintainInput,
): Promise<MaintainOutcome> {
  const owned: { id: number; body: string }[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data } = await client.issues.listComments({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.pullNumber,
      per_page: PER_PAGE,
      page,
    });
    for (const c of data) {
      if (c.user?.login !== input.botLogin || typeof c.body !== "string") continue;
      const marker = parseMarker(c.body);
      if (marker && marker.repositoryId === input.marker.repositoryId) {
        owned.push({ id: c.id, body: c.body });
      }
    }
    if (data.length < PER_PAGE) break;
  }
  if (owned.length > 1) {
    return { action: "ambiguous", commentIds: owned.map((c) => c.id) };
  }
  const existing = owned[0];
  if (!existing) {
    const { data } = await client.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.pullNumber,
      body: input.body,
    });
    return { action: "created", commentId: data.id };
  }
  if (existing.body === input.body) {
    return { action: "unchanged", commentId: existing.id };
  }
  const { data } = await client.issues.updateComment({
    owner: input.owner,
    repo: input.repo,
    comment_id: existing.id,
    body: input.body,
  });
  return { action: "updated", commentId: data.id };
}
