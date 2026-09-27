# Corpus check: streak counter and promotion to required (#172)

The corpus check (`.github/workflows/corpus.yml`, harness `scripts/corpus.mjs`,
docs in `corpus/README.md`) is the gate that lifts the `unused` severity cap
(#173) and the `medium` confidence cap (#178) once it has stayed green for 14
consecutive nightly runs. This document is the on-the-record definition of
the streak counter and of what "promoted to required" means, so the flip is
not a design exercise when the day comes.

## The streak counter (question 3)

`scripts/corpus-streak.mjs` runs as the `streak` job of the nightly workflow
and recomputes the streak statelessly from the Actions run history of
scheduled `corpus.yml` runs. Nothing is stored between runs; the counter
cannot drift from the history it counts.

Day classification, in UTC, scheduled runs only (`workflow_dispatch` is not
the nightly clock):

- **green** - a scheduled run's `corpus` job concluded success that day
- **red** - a scheduled run's `corpus` job concluded failure/cancelled that day
- **no-signal** - no scheduled run exists for that day

The rule (the cap ruling): green +1, red resets, no-signal neither counts nor
resets, and a third consecutive no-signal day breaks the window (streak = 0).
Only fully elapsed days are evaluated: the night still in progress is not a
miss yet. Days older than the first recorded scheduled run end the count
(`exhaustedHistory`), they are not misses.

Two deliberate choices:

- **The corpus job's conclusion is counted, not the workflow run's.** A
  failure of the `streak` job itself (or any future sibling job) can never
  read as a corpus red and reset the streak it reports.
- **Multiple runs on one day**: any green makes the day green (a same-day
  rerun fixes the night); otherwise red.

Machine-visible surface: every nightly upserts one comment on issue #172
(marker `<!-- corpus-streak -->`) holding a fenced JSON block -
`{ streak, target, capLiftReady, consecutiveMisses, windowBroken,
exhaustedHistory, evaluatedThrough, rule }` - plus the same JSON in the job
summary. `capLiftReady: true` is the 14-consecutive-green criterion, readable
via the issues API without scraping logs.

## Promotion to required (question 4)

**Definition.** The corpus check is promoted when the streak comment reports
`capLiftReady: true` (14 consecutive green nightlies). Promotion means the
`corpus` status check is **required on every PR to main**, with the full
24-repo scan executing on exactly the PRs that can drift findings: PRs
touching

- `corpus/**` (pins and goldens)
- `scripts/corpus*` (the harness, its parser, its tests, the streak counter)
- `.github/workflows/corpus.yml`
- `packages/**` (the engine and CLI whose behavior the goldens pin)
- `pnpm-lock.yaml` (the dependency surface the detectors see)

**Why the pre-wiring.** GitHub holds a required check "Pending" forever when
its workflow is skipped by trigger path filtering, which would block every
non-corpus PR. So the workflow fires on _all_ PRs and the `changes` job
gates the scan to the paths above; a job skipped by a conditional reports
Success, keeping the check satisfiable on untouched paths. The path list
lives in one place (`scripts/corpus-gate.mjs`), pinned by
`scripts/corpus-gate.test.mjs`.

**Gating fails closed.** If the `changes` job does not succeed (its diff or
classification broke), the `corpus` job runs and fails immediately instead
of skipping: a skipped job would report Success and let a required check
pass with no scan. Relevant, docs-only, and gating-failure behavior is
pinned by the gate tests plus the fail-closed step in the workflow.

**The flip (one line).** A maintainer adds the `corpus` check to the required
status checks of the main branch ruleset. That is the whole change: the
trigger, the gating, and the check name are already live, so promotion is a
one-line settings change with zero repo diff.

**Verifying the flip.** Open one PR touching `packages/**` (scan must run and
gate) and one touching only docs (check must report Success without scanning).
Both must be blocked from merging while the `corpus` check is failing or
pending, and mergeable when green.
