# Where GhostDeps fits

Research for [#21](https://github.com/rowkavdev/ghostdeps/issues/21). Based on the linked tool studies and GhostDeps main on 25 September 2026.

## The landscape

| Question | Specialist tools | GhostDeps boundary |
| --- | --- | --- |
| Which declared packages lack references? | [Knip](js-unused-dependencies.md), [cargo-machete/udeps](rust-unused-dependencies.md), [deptry/FawltyDeps](python-dependency-tools.md), [Go tooling](go-module-tools.md) | Static evidence across supported ecosystems, but an absence becomes an `unused` verdict only when reference analysis is complete. Today Rust, Python and Go do not claim that completeness. |
| What does a package cost? | [Bundlephobia and Packagephobia](package-cost.md) | Lockfile-derived transitive/exclusive counts with completeness limits; optional npm install footprint, not browser bundle size. |
| What components exist? | [Syft and cdxgen](sbom-tools.md) | No SBOM import/export. Inventory does not show whether a dependency is used. |
| What connects to what? | [deps.dev and module graph tools](dependency-graph-tools.md) | Repository-specific lockfile graph and per-adapter source references, not a generic public-package resolution. |
| What changed in a PR? | [GitHub Dependency Review API](github-dependency-review.md) | Own static compare/manifest diff with conservative fallback; no requirement for GitHub Advanced Security. |
| Where are results shown? | [SARIF/code scanning](sarif.md) | GitHub Checks first, CLI human/JSON second; no SARIF today. |

## What is distinct today

GhostDeps combines declared dependencies, lockfile graphs, source and configuration usage, native-alternative and overlap checks, and factual health/impact notes in one [evidence and confidence policy](../recommendation-policy.md). It reads untrusted repositories without running their scripts or installing their dependencies. A missing file or an incomplete reference check lowers what it can say rather than becoming removal advice. It reports through [GitHub Checks](../github-app.md), with PR annotations only where the PR added the cited line.

This is **not** a claim that GhostDeps is more accurate than a mature specialist in that specialist's ecosystem. The JS/TS reference scan has a different coverage model from Knip's entry-point reachability; Rust, Python and Go do not currently issue unused removal verdicts. Native replacement and overlap rules are bounded, versioned evidence, not a general proof that every imported package has a safe alternative. Transitive impact is incomplete where lockfile graphs are partial, notably Go. See [adapters](../adapters.md) and [interpreting results](../interpreting-results.md) before acting on a finding.

## Direction

Keep per-ecosystem static scanning and coverage gates, test against specialists on owned fixtures, and prioritise evidence users can verify: exact reference or manifest location, graph completeness, rule and confidence. Expand language features and output formats only through scoped issues and tests. Package URL (purl) may help later interoperability, but it is not GhostDeps' internal key today. Do not claim universal unused-feature detection, universal install-size coverage, or superiority to tools that compile or install a project.
