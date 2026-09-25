# GitHub Dependency Review API

Research for [#19](https://github.com/rowkavdev/ghostdeps/issues/19). Checked against GhostDeps main and GitHub's REST documentation on 25 September 2026.

## Problem

A pull request can add, remove or update dependencies. GhostDeps needs an accurate change set to keep findings and annotations relevant, but a dependency diff alone does not establish whether the new package is needed.

## Existing solution

GitHub's [dependency review endpoint](https://docs.github.com/en/rest/dependency-graph/dependency-review) compares two commits at `GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}`. Its response includes the manifest, ecosystem, package name/version, change type, package URL, licence and known vulnerability data; scope can be `unknown`, `runtime` or `development`. It accepts an optional `name` path filter. The installation token needs `contents: read` for private resources. GitHub documents a 403 for a private repository without GitHub Advanced Security or when used against a fork. Coverage follows GitHub's dependency graph, not GhostDeps' own manifest parser.

## Useful techniques and limits

A diff-first view can reduce PR noise, and GitHub's scope and vulnerability data may enrich a known package. But the endpoint is not a proof of usage, and its unavailability or omitted manifest types cannot safely narrow GhostDeps' analysis. GitHub's `package_url` is a purl-like identity in the response; GhostDeps does not have a purl internal key, so any future mapping needs explicit ecosystem/manifest and alias handling rather than a direct assignment.

## Fit with GhostDeps today

The [GitHub App](../github-app.md) **does not call the dependency review endpoint**. For same-repo PRs it fetches the `base...head` compare diff under `contents: read`, reads changed `package.json` manifests at both SHAs as text, and uses core's [dependency-change extractor](https://github.com/rowkavdev/ghostdeps/blob/main/packages/core/src/diff/dependency-changes.ts) to scope JS/TS findings. Source-line changes help with annotations. If the diff or manifest read is incomplete, the App falls back to a full-repository analysis, because narrowing on partial data could hide a finding. Fork re-runs without a PR link also get full analysis. Other ecosystems' manifest-change coverage is not implied by the current JS/TS PR path.

## Recommendation

Keep the self-owned static diff as the authoritative scope. A future optional GitHub dependency-review enrichment must be gated on availability and completeness, must not replace repository-local evidence, and must not add a required permission or make private/fork scans depend on Advanced Security. Do not change internal package identity to purl as part of an API integration shortcut.
