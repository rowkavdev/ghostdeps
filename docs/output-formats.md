# Output formats (shared targets)

The CLI and GitHub Check share an analysis result, but not every example below
is implemented. Current output is identified separately from proposed formats.
When a proposed example differs from shipped code, do not treat it as a live
capability.

## Repository summary (full scan: CLI `scan`)

The shipped CLI renderer produces this exact shape for an empty scan:

```text
GhostDeps

Languages:
  none detected

Package managers:
  none detected

Direct dependencies:
  0

Transitive dependencies:
  unknown

Findings:
  none
```

The following expanded example is **proposed**, not a sample of one currently
shippable run. It combines future native/duplicate verdicts and a PR-only
removed-last-usage finding with a full-scan title; current `unused` confidence
is capped at medium. For today's verdicts and coverage gates, see
[recommendation policy](recommendation-policy.md).

```text
GhostDeps

Languages:
  TypeScript
  Python
  Rust

Package managers:
  pnpm
  uv
  Cargo

Direct dependencies:
  112

Transitive dependencies:
  1,482

Findings:
  5 unused
  8 potentially unnecessary
  3 native replacements
  2 duplicate capabilities

Verdicts:
  unused:
    left-pad - declared as a runtime dependency but never imported (high confidence, rule: unused)
      - no import, require or dynamic import of left-pad found
      - impact: 3 transitive packages; removing it drops 2 of them; at least 48.2 kB installed (4 of 4 packages sized, npm unpackedSize)
    moment - imported only from a file deleted in this PR (medium confidence, rule: unused)
      - last import removed in src/legacy/report.ts
  should be dev dependencies:
    typescript - imported only from tests and build config (high confidence, rule: should-be-dev)
      - imports found only under test/ and build/

Package facts:
    left-pad - left-pad locked version 4.0.0 published 2020-01-02T00:00:00Z (source: npm registry time[version]; declared in package.json, javascript-typescript)

Notes:
    eslint - no imports of eslint found; scripts and config were not checked (low confidence, rule: unverified-no-imports)
      - no import of eslint found
    (repository-wide) - unused confidence capped pending corpus validation (high confidence)

Awareness notes:
    left-pad - left-pad provides the same capability as left_pad (pip) (high confidence, rule: cross-ecosystem-capability-overlap)
      - same capability in npm and pip
```

`Transitive dependencies` reads the per-ecosystem graph completeness
markers (#114): it prints the exact total only when every ecosystem's graphs
are `complete`, `at least N` when the total is a lower bound (`partial`
graphs, or a pre-#114 result with no marker), and `unknown` when no usable
graph was built at all. It never prints `0` for "we could not see".

`Verdicts` expands the non-info findings from the counts: one group per
kind in canonical order, each verdict with its dependency, summary,
confidence and rule id, then evidence lines (capped, with a "+N more" note
when truncated). The section is omitted when there are no verdicts.
Everything verdict-derived is terminal-escaped.

Removal verdicts (`unused`, `potentially unnecessary`, `duplicate
capabilities`) get one `impact:` line from `impact[]` (#59) when core knows
something. It shows the transitive count (`at least N` on a partial graph),
`removing it drops M of them` only when core computed `exclusive`, and
the footprint as `at least X installed (S of T packages sized, basis)`,
since footprint is a lower bound. The entry is matched by dependency name
and the declaring project (the directory of the finding's manifest). With
no match, an ambiguous match, unknown or `limited` counts, the line is
omitted, never printed as `0`. Impact is a fact: it never changes a
verdict, a count or the exit code.

`Package facts` lists the source-backed health observations core groups
as `fact` (#61/#351): registry deprecation, repository archival and
locked-version publication for the exact locked direct dependency. One line
per fact - dependency, core's summary verbatim, then the structured
provenance in parentheses (`source: <basis>; declared in <path>,
<ecosystem>`). Presenters never parse the summary or evidence for
semantics, and add no relative-age badges or newer-available framing. The
section never affects the `Findings` tally, `--fail-on`, the `--severity`
hidden count or the exit code, and is omitted when there are no facts.

`Notes` lists the info findings that say the analysis itself was
incomplete - run-level gaps (partial scans, adapter failures, cap notices)
and manual-review notes such as `unverified-no-imports` - in the same line
shape as verdicts. `Awareness notes` lists the no-action info findings core
explicitly flags with `awareness: true` (#234; absent means not awareness),
classified through core's `findingGroup` (#239) like every presenter. One
presentation rule across surfaces (#206 review): both sections are always
visible, and neither affects the verdict lines or the exit code. Awareness
findings never count (#234): they are excluded from the `Findings` tally,
from the `--fail-on` threshold and from the `--severity` hidden count. Each
section is omitted when it has nothing to show.

## Per-dependency report (proposed CLI `inspect`/`explain`)

The router recognises `inspect` and `explain`, but neither runs yet. The
following per-dependency format and native alternative are **proposed**, not
current CLI or Check output.

```text
axios

Used in:
  src/api/users.ts
  src/api/posts.ts

Functionality used:
  HTTP GET
  JSON parsing

Native alternative:
  fetch()

Dependency impact:
  27 transitive packages
  ~1.4 MB installed

Replacement difficulty:
  Low

Recommendation:
  Probably unnecessary

Confidence:
  High
```

Evidence detail expands on request (`explain`, verbose mode):

```text
Potentially replaceable by fetch()

Evidence:
✓ target runtime includes native fetch
✓ only axios.get() is used
✓ no interceptors detected
✓ no custom adapter detected
✓ no cancellation API detected
✓ no axios-specific error handling detected

Affected files:
2

Estimated replacement:
~12 LOC

Confidence:
High
```

When analysis is incomplete, say so instead of guessing:

```text
Manual review recommended.

Reason:
Dynamic imports prevent complete analysis.
```

## GitHub Check output (PR analysis)

The `axios` native-alternative example below is **proposed**. The shared
Check renderer currently reports shipped findings and coverage notes through
its summary and added-line annotations, not a native-replacement verdict.

```text
GhostDeps — Dependency Analysis

1 new direct dependency

axios

Usage detected:
  src/api/client.ts

Detected functionality:
  HTTP GET requests
  JSON responses

Native alternative:
  fetch()

Impact:
  +27 transitive packages

Recommendation:
  Consider whether axios is necessary.

Confidence:
  High
```

Quiet case — exactly this, no extra prose, and no PR comment:

```text
✓ GhostDeps

No significant dependency issues found.
```

## Rules

- Conservative wording: "potentially unnecessary", "consider whether" —
  never "remove this".
- Findings carry confidence and evidence; uncertainty downgrades.
- Every finding in the JSON output carries `severity`, stamped by core (#188).
  Renderers and gates read it and never re-derive it from `confidence`.
- A finding with `awareness: true` (#234) is for awareness only: presenters
  list it in an awareness section, and it never affects a check conclusion,
  title, count or exit code. Only core sets it, from the rule that emits the
  finding (today `cross-ecosystem-capability-overlap` (#55),
  `same-ecosystem-capability-duplicates` (#58) and the adapter
  capability notes, `adapter-capability`, #205). Absent means not
  awareness: other info findings stay in Notes and keep their neutral
  meaning. Marking another rule awareness needs arbiter sign-off.
- Core also groups source-backed health observations as `"fact"`. They do
  not affect counts, severity gates or check conclusions. Presenters list
  them in a dedicated Package facts section (#385) - CLI human output and
  the GitHub Check summary - with their structured `source` and
  `declaringManifest` provenance, as the
  [interpreting-results guide](interpreting-results.md) describes.
- Presenters group findings with core's `findingGroup(f)` (#239) and own
  only the formatting:
  - `"verdict"`: every non-info finding; drives the conclusion and exit code
    per severity.
  - `"incomplete"`: engine cap and incompleteness notes, and any other info
    finding without a marker. Listed in Notes; a run whose only notes are
    these is neutral "Analysis incomplete".
  - `"note"`: non-capping run notes marked `adapterNote: true` by the
    engine: adapter run-level notes (rule `adapter-note`, #205) and the
    impact work-limit note (rule `impact-limited`, #59). Listed in Notes; the check
    stays success.
  - `"awareness"`: `awareness: true`. Awareness section, never affects
    anything.
    Only an explicit `true` marker moves an info finding out of
    `"incomplete"` (fail-closed), and the engine strips both markers from
    adapter and policy output.
- Check conclusions: `success` when quiet, `neutral` with findings,
  never `failure`. GhostDeps advises, it does not gate.
- PR comments only when a finding cannot be expressed as a check annotation.
