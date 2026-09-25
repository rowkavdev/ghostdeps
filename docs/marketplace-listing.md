# GhostDeps listing draft

This is copy for a future GitHub Marketplace listing. It is not published, and it should be checked against a live installed app before submission. Do not advertise features still planned in the architecture documents as shipped.

## Name

GhostDeps

## Short description

Understand which dependencies your code actually uses, with evidence in GitHub Checks.

## Long description

GhostDeps analyses dependency changes on pull requests and pushes. It reads manifests, lockfiles and source code, then shows findings and limitations in a GitHub check with line annotations where possible. It is conservative about removal advice: if the scan is incomplete or usage cannot be proven, it tells you what it could not verify rather than treating missing evidence as proof a package is unused.

GhostDeps is early-stage software. The app currently loads JavaScript/TypeScript, Rust, Go and Python adapters; coverage and confidence vary by ecosystem and finding. Check current [documentation](https://github.com/rowkavdev/ghostdeps/tree/main/docs) and [release notes](https://github.com/rowkavdev/ghostdeps/releases) for working coverage before using a finding to change production dependencies. Findings are advisory: the GitHub App reports `success` or `neutral`, not a blocking failure.

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

Installing the app queues an initial scan of each selected repository's default branch head; adding repositories later queues their default branch heads too. There is no hosted dashboard or automatic remediation PR. The service runs as one long-lived Node process; [self-hosting guidance](deployment.md) is available, but production registration and Marketplace submission are not complete.

## Security and privacy

GhostDeps asks for read access to repository contents and pull requests so it can inspect dependency files and source changes in the repositories you select. It asks for write access to Checks to post findings on commits, plus GitHub's required metadata read access. It does not ask to write code, issues or pull requests. It receives GitHub webhooks, downloads a bounded copy of the repository for static analysis, then removes that temporary checkout. It does not install packages or run repository code.

The service keeps its queue, recent job state and bounded re-run results in memory, not a persistent scan-history database. Check results live on GitHub; operator logs have their own retention policy. Optional npm footprint lookups are off by default. If enabled, only package names and exact versions with lockfile evidence of the public npm or Yarn registry are sent to `registry.npmjs.org` for size and limited health facts; private or uncertain origins are skipped. The adapter's offline setting is not an OS-level network sandbox, and the App credentials currently share the same service process as analysis workers. The stronger isolation work is tracked in [#326](https://github.com/rowkavdev/ghostdeps/issues/326).

This copy remains unpublished. Before any Marketplace submission, the operator must supply a verified privacy policy, support address, public deployment URL and accurate operator-specific log-retention details; this draft does not supply them.

## Category and tags (suggested)

Code quality; dependency analysis; GitHub Checks.
