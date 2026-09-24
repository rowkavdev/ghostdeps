# Recommendation policy

The default policy (`packages/core/src/recommend/`, #121) turns adapter facts
into findings. It follows ADR 0004: uncertainty lowers a verdict and never
raises it, and ambiguous evidence never produces a removal verdict.

## Rules

Each rule is a pure function over one dependency and the pre-indexed facts.
Rules run in order and the first finding for a dependency wins.

| Rule id                 | Kind            | Confidence | When                                                                                                                                                                                        |
| ----------------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removed-last-usage`    | `unused`        | high       | PR mode only (#101): still declared, no usage at head, and usage analysis found it on a line the PR removed (`Usage.removedInPr`). Same guards as `unused`; the removed lines are evidence. |
| `unused`                | `unused`        | high       | No usage of any kind, not allowlisted, no used `@types` companion, no other direct dependency depends on it, and the ecosystem is reference-analysed.                                       |
| `unverified-no-imports` | `info`          | low        | No imports found, but scripts/config were not checked, or another direct dependency depends on it. Manual review only.                                                                      |
| `type-only`             | `type-only`     | medium     | A runtime dependency whose every usage is a type-only import, in an ecosystem that strips types.                                                                                            |
| `should-be-dev`         | `should-be-dev` | medium     | A runtime dependency imported only from test, build or config paths.                                                                                                                        |

Peer and optional dependencies, and non-registry specifiers (workspace, link,
file, git), never get a no-imports verdict.

A usage with `removedInPr: true` sits on a line the pull request removed. No
rule counts it as usage at head. In PR mode, a dependency with such a usage
counts as touched by the PR, so `removed-last-usage` can report it even when
the PR changed no manifest. The policy never matches diff lines itself:
adapters do that in usage analysis, which keeps core ecosystem-free.

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

Reporters derive severity from kind and confidence, not from the rule id. `unused` is capped at `medium` severity (`UNUSED_SEVERITY_CAP`, #173)
until the pinned corpus check (#172) has been green on every nightly run for 14
consecutive days. The cap is the kind's ceiling, and confidence still drops rungs
below it: high → medium, medium → low, low → info. Lifting it is a one-line change
plus the contract test in `severity.test.ts`. A regression after the lift does
not bring the cap back by itself; that needs a fresh decision.
`summariseFindings` returns counts by kind, rule and confidence for check-run
summaries.
