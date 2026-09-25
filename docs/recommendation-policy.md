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

The confidence core emits for `unused` findings is capped too (#178):
min(computed, `medium`), set by `UNUSED_CONFIDENCE_CAP`. It never raises
confidence. The engine applies the cap where findings are assembled, never in
the CLI or check-run renderers, so every surface shows the same value. When it
capped anything, the result carries one run-level `unused-confidence-capped`
info note ("unused confidence capped pending corpus validation"). The lift
criterion is the same as the severity cap, and both caps come off in one PR
with their contract tests.

How the two caps compose (#188): the engine works out each finding's severity
from its computed confidence, stamps it on the finding (`severity`), and only
then applies the confidence cap. Consumers read `severity` and never re-derive
it from the capped confidence. So an `unused` finding computed at high
confidence is severity medium (the #173 ceiling) with displayed confidence
medium. It does not drop twice to low, so `--fail-on medium` still catches it.
The pre-cap confidence is not part of the output. This note comes off with
both caps in the lift PR.
`summariseFindings` returns counts by kind, rule and confidence for check-run
summaries.

## Health observations (#61)

Core consumes optional `packageFacts` from the caller's cached metadata provider
at the analysis boundary. The policy and adapters never fetch metadata. Only
exact locked direct dependencies with a single known registry origin and
version are queried; the provider may omit any package or field. Missing,
malformed, conflicting or timed-out facts produce no signal and do not block
the scan. In PR mode, only added or changed dependencies get health observations.

Explicit `deprecated: true` and repo-host-sourced `repositoryArchived: true`
(with runtime-checked `sourceKind: "repository-host"`)
produce separate factual `info` findings with their source basis. A
`publishedAt` date reports **when the locked version was published**, not the
last release of the project. An old locked version does not mean the project
is stale. No release cadence or "newer version available" claim is made from
these fields. False or absent flags do not imply a positive health claim. None
of these observations recommends removing a dependency.
