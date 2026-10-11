# ADR 0008: Reporting-only comments through the Action and App

- Status: Proposed
- Date: 2026-10-11

## Decision

Offer reporting-only PR comments independently of ADR 0006's gated fix-preview
and apply rollout. The Action opts in with `comment: "true"`; the App opts in
with `GHOSTDEPS_PR_REPORT=true`. Both reuse the check renderer, keep an analysed
SHA in the comment, maintain their own bot-authored marker, and preserve checks
when comment delivery fails. Prefer one publisher per repository.

The App manifest adds only `issues: write`. Contents remains read-only, and
there is no new event subscription. The comment client remains narrowed to
one repository and issues write only. Existing installations must accept this
permission in GitHub; the checked-in manifest does not change live grants.

This separates report delivery from ADR 0006 activation: it neither enables
interactive fix previews nor dispatches or applies changes. ADR 0006's gates
continue to govern those features. The live App deployment is configured only
after the reporting code and permission change have been reviewed.

## Validation

Action tests cover creation, stale and closed PRs, forks, and permission decline.
Shared delivery tests cover create/update/no-op, spoofed authors, ambiguous
ownership and bounded pagination. Worker tests cover report-only delivery and
declined permissions preserving the check. NowPlaying is the live Action
consumer test; a deployed App integration requires installation credentials.
