# SARIF and GitHub code scanning

Research for [#20](https://github.com/rowkavdev/ghostdeps/issues/20). Checked against GhostDeps main and GitHub's SARIF documentation on 25 September 2026.

## Problem

GhostDeps findings already appear in GitHub Checks. SARIF would put some results into code scanning alerts, a different surface with different persistence, identity and access expectations. An unused dependency is not necessarily a code vulnerability, so alert semantics matter as much as output syntax.

## Existing solution and constraints

GitHub accepts a subset of SARIF 2.1.0 via its [upload action or API](https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/uploading-a-sarif-file-to-github). Its [SARIF limits](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support) include 10 MB per gzip-compressed file, 20 runs per file, 25,000 results per run (top 5,000 kept by severity), 25,000 rules per run, 1,000 locations per result (100 kept), and 20 tags per rule (10 kept). The upload path also needs the repository's code-scanning availability and appropriate permissions, which is not the same as writing Checks.

Stable alert identity is a separate obligation: `partialFingerprints` help GitHub match recurring results. The upload action may try to fill missing fingerprints from source files, but direct `/code-scanning/sarifs` API uploads without them can show duplicate alerts. `runAutomationDetails.id` can distinguish categories/runs of the same tool. A fingerprint must stay stable across lines moving while still separating distinct ecosystem, package, manifest and rule contexts; deriving one naively from a package URL is insufficient for aliases and local dependencies.

## Fit with GhostDeps today

The [GitHub App](../github-app.md) reports through Checks with a quiet success or neutral review conclusion. The [Checks renderer](https://github.com/rowkavdev/ghostdeps/blob/main/packages/checks-renderer/src/render.ts) annotates only high-confidence findings on added PR lines and caps annotations at 50; other results remain in the summary. The [CLI](../cli.md) offers human and JSON output. GhostDeps currently has no SARIF renderer or upload, and no `--format sarif` option. A code-scanning integration must not be implied to work on private repositories without checking their entitlement and permissions.

## Recommendation

Keep Checks as the primary and default surface. If users need SARIF interoperability, start with an opt-in CLI export proposal with rule IDs, evidence locations, stable fingerprints, size caps and tests for repeat uploads. Decide separately whether non-security findings belong as persistent code scanning alerts. Do not silently upload or require code-scanning access from the App.
