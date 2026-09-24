# Recommendation policy

The default policy (`packages/core/src/recommend/`, #121) turns adapter facts
into findings. It follows ADR 0004: uncertainty lowers a verdict and never
raises it, and ambiguous evidence never produces a removal verdict.

## Rules

Each rule is a pure function over one dependency and the pre-indexed facts.
Rules run in order and the first finding for a dependency wins.

| Rule id                 | Kind            | Confidence | When                                                                                                                                                  |
| ----------------------- | --------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unused`                | `unused`        | high       | No usage of any kind, not allowlisted, no used `@types` companion, no other direct dependency depends on it, and the ecosystem is reference-analysed. |
| `unverified-no-imports` | `info`          | low        | No imports found, but scripts/config were not checked, or another direct dependency depends on it. Manual review only.                                |
| `type-only`             | `type-only`     | medium     | A runtime dependency whose every usage is a type-only import, in an ecosystem that strips types.                                                      |
| `should-be-dev`         | `should-be-dev` | medium     | A runtime dependency imported only from test, build or config paths.                                                                                  |

Peer and optional dependencies, and non-registry specifiers (workspace, link,
file, git), never get a no-imports verdict.

## What counts as usage

Before `unused` is possible, all of these must be empty:

- source imports (`Usage.via` absent or `"import"`),
- any other `Usage.via` value (`"script"`, `"config"`, `"convention"`),
- the curated dev-tooling allowlist (`allowlist.ts`, per ecosystem),
- for `@types/foo` in a TypeScript repo: usage of `foo` (`@types/scope__pkg` maps to `@scope/pkg`).

`unused` also needs the ecosystem in `RecommendationInput.referenceAnalysedEcosystems`. The engine adds an ecosystem only when all of these hold:

- usage analysis completed (not timed out, failed or capped),
- the adapter declares the `referenceAnalysis` capability,
- every `findUsage` result for the run returned `referenceAnalysisComplete: true` (an array, an omitted flag or `false` counts as incomplete, and one incomplete dependency clears the whole ecosystem),
- `AnalyseOptions.scanIncomplete` is not set. `analyseDirectory` sets it when the scan was truncated or skipped paths; the GitHub App sets it from its tarball scan.

Otherwise "no usages" could mean "never looked", so the policy emits `unverified-no-imports` instead.

## Pull-request mode

When `RecommendationInput.mode` is `"pull-request"`, only dependencies the PR
added or changed (from `pullRequestChanges`) get findings. Removed
dependencies and untouched ones get none, and a source-only PR (empty
changes) gets none. The policy passes `runRecommendationPolicyContractTests`
in both modes.

## Config

```ts
createDefaultPolicy({
  disabled: ["should-be-dev"], // turn rules off
  downgrade: { unused: "medium" }, // cap confidence (never raises)
  allowlist: { "javascript-typescript": { exact: ["my-cli"] } },
  typeStrippingEcosystems: ["javascript-typescript"],
});
```

Reporters derive severity from kind and confidence, not from the rule id.
`summariseFindings` returns counts by kind, rule and confidence for check-run
summaries.
