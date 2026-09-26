# ADR 0006: PR-comment delivery and App permission evolution

- Status: Proposed (owner acceptance gate; see Activation below)
- Date: 2026-09-26
- Supersedes: the permission set, event list and "rare PR comments" clauses of [ADR 0003](0003-github-app-architecture.md) for the PR-comment delivery feature only. Every other ADR 0003 decision stands.

## Context

ADR 0003 fixed the App's installation ceiling at `contents: read`, `pull_requests: read`, `checks: write` and `metadata: read`, with webhook events limited to `pull_request`, `push`, `installation` and `installation_repositories`, and PR comments "only when they add value beyond the check (rare)". It also anticipated this ADR: "Remediation PRs (M4) will request `contents: write` + `pull_requests: write` as a separate, opt-in app permission change, not silently."

ADR 0005 (Accepted 2026-09-26) and the [PR comment and tick-to-apply design](../pr-comment-apply-design.md) define user-facing delivery through one maintained PR comment and a maintainer-triggered, head-pinned Action on the repository runner. That delivery needs capabilities ADR 0003 excluded: writing issue comments, receiving `issue_comment` events, and - for same-PR manifest and lockfile commits by the trusted runner path - `contents: write`. The gated draft #406 carries the manifest delta (`contents: write`, `issues: write`, `issue_comment` subscription) and reviewer-2's gate review of 2026-09-26 requires this explicit superseding decision before any activation, alongside token-narrowing audits and the remaining acceptance properties.

The risk this ADR controls: a wider installation ceiling becomes ambient authority if every code path keeps using installation-wide tokens. The ceiling is a product decision; what each path may actually do is an engineering invariant, and the two must be decided separately.

## Decision

**Raise the App's installation ceiling exactly once, as the opt-in change ADR 0003 anticipated, and bind every operational path to explicitly narrowed tokens under a broker/child credential split.**

1. **Ceiling change (the whole of it).** The App manifest may add `contents: write`, `issues: write` and the `issue_comment` webhook event for the PR-comment delivery feature. Nothing else is granted by this ADR. `actions: write` is not granted; dispatch to the trusted Action uses the repository's own workflow mechanism as specified in the delivery design. The permission table, event list and docs in #406 are the instrument of this clause and must remain in parity (docs/github-app.md, app.yml, parity test).

2. **Broker/child credential split.** A broker holds installation-wide credentials and never serves feature traffic directly. Every operational path mints a child token with an explicit, path-specific narrowing:
   - Scan worker (unchanged from ADR 0003 behaviour): one-repository `contents: read` + `checks: write`.
   - Webhook lookup path: explicit narrowing to the repositories and permissions its reads require; minting an unnarrowed installation token here is a defect.
   - Dispatch token: narrow, single-purpose, constrained per the delivery design.
   - Comment editor: `issues: write` only, checked before use.
   - Ambient `context.octokit` usage is not permitted on paths that handle untrusted input; each such handler moves to an explicitly narrowed client.
     These narrowings are acceptance properties with adversarial tests (the #411 hardening PR carries the first of them), not documentation aspirations.

3. **Decline and revocation behaviour.** If an installation declines the wider permissions, scanning keeps working on the old ceiling; the comment/apply features stay off and say so. Decline-preserves-scans is a coded acceptance property. Installation effective-rights detection decides feature availability from what the installation actually granted, never from what the manifest requests.

4. **Comment behaviour (superseding ADR 0003's "rare" clause for this feature).** The App maintains exactly one comment per PR for the delivery design, updated in place. Checks behaviour from ADR 0003 is unchanged: one check run per analysed head SHA, `success`/`neutral`, never `failure`. GhostDeps still does not gate merges.

5. **What this ADR does not do.** It does not activate anything. It does not weaken ADR 0004 (no repository code executes in analysis; dynamic verification stays disabled until its own isolation decision). It does not alter ADR 0005's rollout conditions. It does not authorise auto-apply, auto-merge, or any write that is not maintainer-triggered and head-pinned.

## Activation

Activation of the comment/apply features requires ALL of:

- Owner acceptance of this ADR and of the live App permission update, separately confirmed on the owner's channel.
- Slice-2 evidence gates and M3 stability per ADR 0005's rollout section.
- Reviewer security sign-off on the exact head carrying the implementation, including the token-narrowing audits and the declined-scan, signed-envelope, replay and stale-head acceptance properties.
- The broker/child credential split implemented and tested (#326).

Until every condition holds, #406 and its successors remain gated drafts and the live App registration keeps the ADR 0003 permission set.

## Consequences

- ADR 0003 stays on the record unedited; this ADR is the dated superseding instrument reviewer-2 required.
- Any future permission request is a new opt-in change of the same kind: documented here-style, owner-accepted, never silent.
- The permission ceiling and the per-path token contract are reviewed on every PR that touches the manifest, the broker, or token minting.
