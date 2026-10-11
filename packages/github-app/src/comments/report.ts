import { maintainPrReport, type CheckOutput } from "@ghostdeps/checks-renderer";
import type { IssuesClient } from "./state.js";
import { commentLockKey, withCommentLock } from "./queue.js";

/** Reporting uses the same per-PR writer lock as the gated interactive path. */
export async function deliverReport(
  client: IssuesClient,
  input: {
    owner: string;
    repo: string;
    repositoryId: number;
    pullNumber: number;
    botLogin: string;
    sha: string;
    rendered: CheckOutput;
  },
): Promise<{ action: string }> {
  return withCommentLock(commentLockKey(input.repositoryId, input.pullNumber), async () => {
    const { owner, repo, pullNumber: issue_number } = input;
    const { data: live } = await client.issues.get({ owner, repo, issue_number });
    if (live.state !== "open") return { action: "skipped-closed" };
    return {
      action: await maintainPrReport(
        {
          listComments: async (page) =>
            (await client.issues.listComments({ owner, repo, issue_number, per_page: 100, page }))
              .data,
          createComment: (body) => client.issues.createComment({ owner, repo, issue_number, body }),
          updateComment: (comment_id, body) =>
            client.issues.updateComment({ owner, repo, comment_id, body }),
        },
        { ...input, channel: "app" },
      ),
    };
  });
}
