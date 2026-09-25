# JS/TS unused dependencies: Knip and depcheck

Research for [#12](https://github.com/rowkavdev/ghostdeps/issues/12). Checked against GhostDeps main on 25 September 2026.

## Problem

A package may be declared but never referenced, or used without a direct declaration. A missing entry point, convention-based plugin, generated file or config reference can make a needed package look unused. A missing declaration can be masked by a transitive install.

## Existing solutions

- [Knip](https://knip.dev/explanations/how-knip-works) starts at entry files, follows imports through a module graph and reports unused files, exports and dependencies. Its [plugins](https://knip.dev/reference/plugins) recognise framework entry points and config files. Its results depend on the entry set and configuration; an unreachable file is not proof that its dependency is safe to remove.
- [depcheck](https://github.com/depcheck/depcheck) scans JavaScript projects for unused and missing dependencies. Its README says it is no longer actively maintained and recommends Knip for modern projects.

## Techniques worth retaining

- Account for scripts, configuration and tool conventions, not just source imports.
- Preserve an explanation for each reference and each gap in scanning. A missed file should lower confidence, never strengthen an unused verdict.
- Check undeclared imports separately from unused declarations: a transitive install may make undeclared use work locally without making it reliable.

## Fit with GhostDeps today

GhostDeps **does not run Knip or use Knip's entry-point graph**. The JS/TS adapter scans files within package projects for static imports and requires, script blocks in Vue/Svelte/Astro/HTML, scripts and known config/convention references. It reads these as data and does not run repository code. See [`find-usage.ts`](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/javascript-typescript/src/usage/find-usage.ts), [`config.ts`](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/javascript-typescript/src/references/config.ts) and [adapter status](../adapters.md). This is a different coverage model from Knip's reachability analysis: GhostDeps can credit a dependency imported by an otherwise unreachable file, while Knip can flag that file as unused.

Core only emits an `unused` finding when the adapter has completed reference analysis and other policy guards hold. Otherwise it emits a manual-review `unverified-no-imports` note; `unused` confidence and severity remain capped pending corpus validation. See [recommendation policy](../recommendation-policy.md). GhostDeps also considers native replacements, health observations and transitive impact, which are separate from a tool's unused-import result. PR mode scopes findings to changed dependencies (or a removed last usage); it is not a full-repo Knip report.

## Recommendation

Keep GhostDeps' static, evidence-first scan and compare its false-positive and false-negative cases with Knip on the pinned corpus. Do not replace its current reference scanner with a reachability graph without coverage tests for entry points, config-only uses, monorepos and generated files. An optional Knip import would be another evidence source, not a removal verdict or a required runtime dependency. Depcheck is useful mainly for migration context; do not build a new integration around an unmaintained scanner.
