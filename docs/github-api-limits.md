# GitHub API rate limits and caching (#37)

What limits the GitHub App runs into, what it already does about them, and what is still missing. Facts come from GitHub's docs as read on 24 September 2026. Links are at the end.

## The limits that matter

**Primary (per hour, installation token).** 5,000 requests per installation. Installations with more than 20 repositories get 50 more per repository, and organisations with more than 20 users get 50 more per user, up to 12,500. Installations on GitHub Enterprise Cloud get 15,000. GraphQL has its own budget of points, with the same numbers (10,000 on Enterprise Cloud). Over the limit, GitHub returns 403 or 429 with `x-ratelimit-remaining: 0`. Don't retry before `x-ratelimit-reset`.

**Secondary (can't be queried, can change without notice).**

- At most 100 concurrent requests, shared by REST and GraphQL.
- At most 900 points per minute per REST endpoint. Most `GET` requests cost 1 point and most writes cost 5. GraphQL allows 2,000 points per minute. Some endpoints have costs GitHub doesn't publish.
- At most 90 seconds of CPU time per 60 seconds, and at most 60 of those seconds for GraphQL.
- About 80 content-creating requests per minute and 500 per hour.
- At most 2,000 OAuth access token requests per hour for GitHub Apps and OAuth apps. The docs don't give a figure for installation-token requests.

Over a secondary limit, wait for `retry-after` if it's present. If `x-ratelimit-remaining` is 0, wait until `x-ratelimit-reset`. Otherwise wait at least a minute, back off exponentially, and give up after a fixed number of retries.

**Free requests.** A conditional `GET` (`If-None-Match` with an ETag, or `If-Modified-Since`) that returns 304 doesn't count against the primary limit. `GET /rate_limit` doesn't count against the primary limit either, but it can count against the secondary limits.

## What one analysis costs today

For a pull request that changes M manifests:

| Where                                        | Requests                                                    |
| -------------------------------------------- | ----------------------------------------------------------- |
| Webhook delivery: PR file list (#36)         | 1-5 `GET` (100 files a page, capped at 5 pages)             |
| Worker: repo-scoped installation token (#38) | 0-1 token request (cached, see below)                       |
| Worker: claim the check run                  | 1 `GET` (list for ref) + 1 `POST` (create)                  |
| Worker: PR diff (#115)                       | 1 `GET` (compare, diff format)                              |
| Worker: manifests at both SHAs               | 2 x M `GET` (raw contents)                                  |
| Worker: source tarball                       | 1 `GET` (a redirect; the download itself isn't a REST call) |
| Worker: complete the check run               | 1 `PATCH`                                                   |

That's roughly 7 + 2M requests, about 2 of them writes. A re-run also rebuilds the PR file list (#196). A re-run for the same SHA served from the result cache (#174) skips the diff, the manifests and the tarball. A push costs 1 compare call in the webhook plus the worker's share.

At that rate, the 5,000-an-hour primary limit covers several hundred analyses per installation per hour. The first limit a busy installation would hit is probably the secondary limit on content creation, if check-run writes count towards it. GitHub doesn't say whether they do: 2 writes per analysis would allow about 250 analyses an hour against the 500-an-hour figure.

## Already in place

- **No per-file reads.** The worker downloads one tarball of the exact SHA and reads files locally (#112). The issue's main recommendation is done.
- **Token cache.** Probot keeps an in-process LRU of installation tokens, keyed by installation, repository ids and permissions. A repo-scoped worker token is reused for about an hour, so the worker mints at most one token per repository per hour.
- **Throttling and retry.** Every Probot Octokit, including the worker's per-job client, loads `@octokit/plugin-throttling` and `@octokit/plugin-retry`. They wait for `retry-after` / `x-ratelimit-reset` and serialise writes within a client. How often a client retries a rate limit depends on which defaults built it (see gap 1).
- **Same-SHA result cache (#174, #215).** Re-runs of an unchanged head don't touch the API beyond the check-run writes.
- **Bounded concurrency.** The in-memory queue runs 2 jobs at a time, and one head SHA gets one job.
- **Two check-run writes.** Create in progress, then complete, with at most 50 annotations in the completing request.

## Gaps

1. **The worker's rate-limit retries have no limit.** Fixed by #255: see the app docs. In Probot 14.3.2 (the locked version) the two clients get different throttle handlers.
   - The webhook client comes from the Probot instance (`getOctokitThrottleOptions`). It retries a primary limit while `retryCount <= 2`, waiting for the reset each time, and doesn't retry a secondary limit at all (it only logs). Retries are bounded, but one wait for a primary reset can still run past GitHub's 10-second delivery timeout while the PR file list is being read.
   - The worker builds its client with `new ProbotOctokit(...)`, which uses the class defaults. Those `onRateLimit` and `onSecondaryRateLimit` handlers always return `true`. So a worker job that hits the primary limit waits until the reset, up to an hour, holding one of the 2 worker slots, and it keeps retrying for as long as the limit lasts.

   Proposed fix, per client. The worker passes its own handlers: it retries only while `retryAfter` is at most 60 seconds and at most twice, and otherwise the run ends neutral with "GitHub rate limit reached - re-run later". The webhook's file lookup doesn't wait for a primary reset either: it reports the file list as incomplete, so the PR is analysed in full, as it is for a capped list today. Its secondary behaviour (no retry, the lookup fails and takes the same path) can stay.

2. **No rate-limit telemetry.** Nothing logs `x-ratelimit-remaining`, so we'd only find out about trouble through failures. Proposed fix: after each worker job, log `remaining`, `limit` and `resource` from the last response, and warn below 10% of the limit.
3. **Superseded heads aren't dropped.** A new push to a PR queues a job for the new head, and a queued job for the old head still runs. Proposed fix: when a PR job is queued, drop any queued (not running) job for the same PR with an older head. It's queue-local, and a check run that was never started needs no clean-up.
4. **No per-installation fairness.** The queue is first in, first out across installations, so one busy installation can delay everyone else. This isn't a limit problem at 2 concurrent jobs. Revisit together with the durable queue.

## Not recommended now

- **ETag caching.** The app doesn't poll: every read is pinned to a SHA and happens once per job, so conditional requests would rarely return 304.
- **Content-hash result cache** (lockfile hash to dependency graph). #215 already covers repeated heads. A cross-SHA cache only pays off with a durable store, and it would have to prove that nothing outside the lockfile changes the result.
- **GraphQL for reads.** It would only help with many small reads in one request, and the worker makes a handful of REST calls.

## Development tooling (tonight's GraphQL errors)

The rate-limit errors seen on 24 September came from the maintainers' shared `gh` user token, not from the app. `gh pr create`, `gh pr list`, `gh pr view`, `gh issue view` and `gh project` all use GraphQL. At 9:45 PM `/rate_limit` still showed 4,885 of 5,000 GraphQL points left, which fits a secondary limit (points per minute or CPU time across several agents at once) better than the hourly budget, even though the error text reads like the primary one. REST had its full 5,000 left. What helps:

- Use REST for pull request and issue reads and writes (`gh api repos/...`). Keep GraphQL for Projects, which has no REST API.
- Cache project item ids and make single `updateProjectV2ItemFieldValue` writes. Avoid `gh project item-list` over the whole board, which pages through every item.
- Poll with REST, and with `gh api --cache <duration>` or ETags where the tool allows. A 304 costs nothing against the primary limit.
- Don't make GraphQL calls from several agents at the same moment. Spread them out.

## References

- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps
