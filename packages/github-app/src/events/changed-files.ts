/**
 * Changed-file lookups for event filtering (#36): a bounded PR files
 * listing, or one compare call for pushes. Renames count under both names.
 * A capped list is reported as incomplete so the filter errs toward analysis.
 */
import type { ProbotOctokit } from "probot";
import type { Candidate, ChangedFiles } from "./filter.js";

type Octokit = InstanceType<typeof ProbotOctokit>;

/**
 * Pages of PR files read inside the webhook delivery (100 files each).
 * GitHub times deliveries out after 10 seconds, so larger PRs are reported as
 * incomplete and analysed anyway instead of paging through all 3,000 files.
 */
export const PR_FILES_MAX_PAGES = 5;
/** The compare API returns at most 300 files on its first page. */
export const COMPARE_FILES_CAP = 300;

export async function changedFiles(octokit: Octokit, candidate: Candidate): Promise<ChangedFiles> {
  const { owner, name: repo } = candidate.repository;
  const trigger = candidate.trigger;

  if (trigger.kind === "pull_request") {
    const names: string[] = [];
    let pages = 0;
    let more = false;
    for await (const page of octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: trigger.number,
      per_page: 100,
    })) {
      for (const f of page.data) {
        names.push(f.filename);
        // A renamed manifest no longer matches by its new name; keep the old one too.
        if (f.previous_filename) names.push(f.previous_filename);
      }
      pages++;
      if (pages >= PR_FILES_MAX_PAGES) {
        more = page.data.length === 100;
        break;
      }
    }
    return { files: names, complete: !more };
  }

  if (trigger.kind === "push") {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${trigger.beforeSha}...${candidate.headSha}`,
      per_page: 1,
    });
    const files = data.files ?? [];
    const names = files.flatMap((f) =>
      f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
    );
    return { files: names, complete: files.length < COMPARE_FILES_CAP };
  }

  return { files: [], complete: false };
}
