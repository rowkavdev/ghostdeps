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
```

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
- Check conclusions: `success` when quiet, `neutral` with findings,
  never `failure`. GhostDeps advises, it does not gate.
- PR comments only when a finding cannot be expressed as a check annotation.
