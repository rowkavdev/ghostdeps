# GhostDeps listing draft

This is copy for a future GitHub Marketplace listing. It is not published, and it should be checked against a live installed app before submission. Do not advertise features still planned in the architecture documents as shipped.

## Name

GhostDeps

## Short description

Understand which dependencies your code actually uses, with evidence in GitHub Checks.

## Long description

GhostDeps analyses dependency changes on pull requests and pushes. It reads manifests, lockfiles and source code, then shows findings and limitations in a GitHub check with line annotations where possible. It is conservative about removal advice: if the scan is incomplete or usage cannot be proven, it tells you what it could not verify rather than treating missing evidence as proof a package is unused.

GhostDeps is early-stage software. JavaScript/TypeScript analysis is the first useful path; other ecosystems are being built and validated. Check current [documentation](https://github.com/rowkavdev/ghostdeps/tree/main/docs) and [release notes](https://github.com/rowkavdev/ghostdeps/releases) for working coverage before using a finding to change production dependencies. Findings are advisory: the GitHub App reports `success` or `neutral`, not a blocking failure.

## Suggested feature bullets

- Reviews direct dependencies in the context of changed manifests, lockfiles and source files.
- Shows the evidence and confidence behind each finding, plus notes when analysis was incomplete.
- Reports in GitHub Checks with code annotations rather than routine PR comments.
- Uses static analysis; it does not execute repository code or ask for a language-model key.
- Limits App permissions to repository contents (read), pull requests (read), checks (write) and implicit metadata (read).

## How it works

1. Install the app on the repositories you choose.
2. Open a pull request or push a qualifying change to the default branch.
3. Read the `ghostdeps` check on the commit. Inspect its evidence and limitations before removing anything. Use the check's re-run action if a job could not complete.

Installing the app does not run an initial scan in v0.1. There is no hosted dashboard or automatic remediation PR. The service is deployed as one long-lived Node process; a self-hosted deployment guide is being prepared in a separate PR.

## Data and privacy notes for listing review

The app receives signed GitHub webhook payloads, reads source from selected installations via GitHub's API/codeload, and writes check results. It processes repository content in a bounded temporary checkout; no repository scripts or install hooks are run. v0.1 keeps job state and re-run results in process memory, not a persistent scan-history database. The optional npm install-footprint lookup is off by default and only looks up packages identified as coming from the public npm registry. The operator must provide an accurate privacy policy, support address and public deployment URL before submitting a Marketplace listing; this draft is not a substitute for those details.

## Category and tags (suggested)

Code quality; dependency analysis; GitHub Checks.
