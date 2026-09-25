# Usage aggregation across ecosystems: cost and attribution

Status: measured 2026-09-25 with the pinned worker baseline (`perf/profile-worker.mjs`, full numbers in `perf/REPORT-2026-09-25.md`) and the #345 single-job trace. Behaviour described as current after #331 (usage salvage + dedicated budget) and #390 (usage attribution in output).

## How usage facts aggregate

Each detected ecosystem's adapter runs its own usage stage, in its own worker, under its own budget. `assembleAnalysisResult` then merges every adapter outcome into one `result.usages`. The `Usage` type records no ecosystem: a reader of the merged result cannot tell which ecosystem produced which facts without correlating file paths. The timeout finding names its ecosystem only in the summary text.

That split produced the #345 anomaly: a run that posted `javascript-typescript analysis incomplete: usage analysis timed out` while the same result carried 13,278 usages.

## The measured case: next.js (#345)

Single-job traces against the pinned next.js checkout, isolated engine, default 60 s stage budget:

| run                              | usages | findings                    |
| -------------------------------- | -----: | --------------------------- |
| javascript-typescript only, 60 s |      0 | JS usage analysis timed out |
| all four adapters, 60 s          | 13,278 | the same JS timeout finding |

Attribution of the surviving 13,278 usages by directory: `turbopack/` 9,891, `crates/` 3,353, `rspack/` 28, `scripts/` 5, `test/` 1 - all inside the next-swc Rust workspace, produced by the Rust adapter, which finished inside its own budget. The JS adapter made 2,398 `findUsage` calls and hit ~100% of the 60 s budget; every JS usage fact was discarded, as the timeout path is designed to do. No race, no partial-state leak: one ecosystem's timeout finding can sit next to a sibling's full usage set because the result aggregates ecosystems.

## Cost shape

- Usage analysis is 75-85% of stage time on every repo measured, and the dependency-graph and usage stages run concurrently, so the usage stage is the long pole outright.
- Cost scales with direct-dependency count and import-graph size: 11 calls / 0.12 s on chalk, 484 calls / 3.8 s on vite, 2,398 calls / ~60 s on next.js (4,718 direct dependencies).
- Memory is not what binds. The heaviest single job measured (next.js) peaked at 464 MiB for the whole process - main thread, engine, all four adapter workers - and the worst concurrent pair (next.js + TypeScript) at 627-664 MiB, against a 512 MiB heap ceiling per adapter worker. The wall-clock stage budget binds first.
- Non-JS adapters measured far from the budget (rust 0.61 s, python 0.18 s, go 0.11 s usage stages on real repos). At today's corpus this is a JS-adapter-sized problem.

## Behaviour after #331 and #390

- **Dedicated usage budget.** Usage analysis has its own stage budget, `DEFAULT_USAGE_TIMEOUT_MS` = 5 min (`AnalyseOptions.usageTimeoutMs`; when the caller overrides only `adapterTimeoutMs`, that value still governs). The old flat 60 s default was calibrated for repos ~20x smaller than next.js, where the JS stage sat at ~100% of it.
- **Salvage on timeout.** Settled per-dependency usage facts are kept with `usageAnalysed: false` and `usageIncomplete: true`. Core suppresses absence verdicts for partial usage (fail closed on name collisions), so positive facts survive without weakening the no-false-unused rule.
- **Attribution in output.** When a detected ecosystem's usage stage fails while usage facts survive, core emits one `usage-attribution` note naming each contributing ecosystem with its count and the incomplete ecosystems - e.g. `usage facts come from rust (13,278); javascript-typescript usage analysis did not complete, so that ecosystem has no usage facts in this result`. Salvaged counts are marked partial (`js (1, partial)`). The note is an `adapterNote`: shown in the check's Notes section, never a verdict, and the completeness contract is unchanged.

## Reading aggregated results

A timeout finding next to thousands of usages is not a contradiction; it is cross-ecosystem aggregation. Check the `usage-attribution` note for the contributing ecosystems and counts. On results from before #390, attribute by file-path prefix instead, and treat the timed-out ecosystem's usage set as unknown (or partially salvaged after #331), never as "no usage".

Sources: [worker baseline report](https://github.com/rowkavdev/ghostdeps/blob/main/perf/REPORT-2026-09-25.md), [#345 trace](https://github.com/rowkavdev/ghostdeps/issues/345#issuecomment-5838984101), #331, #390.
