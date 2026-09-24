# Output formats (shared targets)

Every lane renders the same information in the same shapes. These are the
canonical formats from the product spec; when output work disagrees with
this file, this file wins (or the file gets updated in the same PR).

## Repository summary (full scan: CLI `scan`, installation scans)

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
    moment - imported only from a file deleted in this PR (medium confidence, rule: unused)
      - last import removed in src/legacy/report.ts
  should be dev dependencies:
    typescript - imported only from tests and build config (high confidence, rule: should-be-dev)
      - imports found only under test/ and build/
```

`Transitive dependencies` reads the per-ecosystem graph completeness
markers (#114): it prints the exact total only when every ecosystem's graphs
are `complete`, `at least N` when the total is a lower bound (`partial`
graphs, or a pre-#114 result with no marker), and `unknown` when no usable
graph was built at all. It never prints `0` for "we could not see".

`Verdicts` expands the non-info findings from the counts: one group per
kind in canonical order, each verdict with its dependency, summary,
confidence and rule id, then evidence lines (capped, with a "+N more" note
when truncated). Info findings are caveats about the analysis itself (scan
completeness, coverage gaps) and stay in the `Findings` counts only. The
section is omitted when there are no verdicts. Everything verdict-derived
is terminal-escaped.

## Per-dependency report (CLI `inspect`/`explain`, check annotations)

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
  finding (today `cross-ecosystem-capability-overlap` and the adapter
  capability notes, `adapter-capability`, #205). Absent means not
  awareness: other info findings stay in Notes and keep their neutral
  meaning. Marking another rule awareness needs arbiter sign-off.
- Presenters group findings with core's `findingGroup(f)` (#239) and own
  only the formatting:
  - `"verdict"`: every non-info finding; drives the conclusion and exit code
    per severity.
  - `"incomplete"`: engine cap and incompleteness notes, and any other info
    finding without a marker. Listed in Notes; a run whose only notes are
    these is neutral "Analysis incomplete".
  - `"note"`: non-capping run-level adapter notes (rule `adapter-note`,
    `adapterNote: true`, set by the engine, #205). Listed in Notes; the check
    stays success.
  - `"awareness"`: `awareness: true`. Awareness section, never affects
    anything.
    Only an explicit `true` marker moves an info finding out of
    `"incomplete"` (fail-closed), and the engine strips both markers from
    adapter and policy output.
- Check conclusions: `success` when quiet, `neutral` with findings,
  never `failure`. GhostDeps advises, it does not gate.
- PR comments only when a finding cannot be expressed as a check annotation.
