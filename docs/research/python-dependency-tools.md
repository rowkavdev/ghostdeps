# Python dependency tools

Research for [#14](https://github.com/rowkavdev/ghostdeps/issues/14). Checked against GhostDeps main on 25 September 2026.

## Problem

Python imports name modules while manifests declare distributions. `import PIL` can correspond to `Pillow`; imports may also be first-party, standard-library, conditional, type-only or dynamically loaded. An absent import is not enough to recommend removing a dependency that a build system, plugin or script uses.

## Existing solutions

- [deptry](https://deptry.com/rules-violations/) compares imports with declarations and separates missing (DEP001), unused (DEP002), transitive use (DEP003), dev-dependency use in production (DEP004) and standard-library declarations (DEP005). It supports [several manifest formats](https://deptry.com/usage/) and package-to-module overrides. Its pre-commit guidance says to run in the project's virtual environment to access installed-package metadata; that is not suitable as a required GhostDeps GitHub App step.
- [FawltyDeps](https://tweag.github.io/FawltyDeps/usage/) checks undeclared and unused third-party dependencies across several declaration formats and notebooks. Its [mapping strategies](https://tweag.github.io/FawltyDeps/explanation/) use user mapping, installed environments and an identity fallback; an optional install-deps mode installs packages into a temporary environment. GhostDeps must not install or execute a repository's dependencies.
- [Unimport](https://unimport.hakancelik.dev/latest/tutorial/supported-behaviors/) concerns unused import bindings in source files, including `TYPE_CHECKING` cases, not manifest-level unused distributions.
- [pydeps](https://pydeps.readthedocs.io/en/latest/) visualises module imports from bytecode import opcodes. Its own docs say it sees only imported and import-resolvable files, so it is not a complete declaration check.
- [findimports](https://github.com/mgedmin/findimports) parses source to report unused imported names and module graphs. Its README recommends more maintained tools for unused imports and graphs; it is not a distribution-manifest checker.

## Useful techniques and limits

Keep distribution-to-module mapping explicit, distinguish first-party/stdlib modules, and separate runtime from development imports. Deptry's rule split is a useful comparison vocabulary, not an instruction to declare every check supported. Environment-dependent mapping may be precise locally, but installing a project to discover names breaks the static-only boundary. Unresolved names and dynamic/plugin use must remain uncertain rather than silently credited or treated as absent.

## Fit with GhostDeps today

The [Python adapter](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/python/src/adapter.ts) already parses manifests and lockfiles and scans `.py`/`.pyw` imports. Its [resolver](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/python/src/import-map.ts) checks stdlib, first-party modules, committed `top_level.txt`, a curated mapping and then name equality. Multiple declared providers are all credited; unknown imports stay unresolved. It does **not** fetch wheel metadata, install a virtual environment or claim that the map is complete. The [statement scanner](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/python/src/usage/imports.ts) recognises literal dynamic imports and `TYPE_CHECKING` blocks; it is not a full Python parser.

Python usage is evidence only. The adapter does not declare `referenceAnalysis`, so [core policy](../recommendation-policy.md) cannot turn a missing Python reference into an `unused` removal verdict. The earlier issue's proposed wheel-metadata mapping and unused-rule implementation remain future work, not current features.

## Recommendation

Compare mapping and conditional-import cases against deptry/FawltyDeps on owned fixtures. Keep the current static-only boundary and no-unused-verdict gate until coverage for install-name aliases, plugins, build requirements, namespace packages, omitted files and dynamic imports is validated. Import-level tools can inform tests, but should not be presented as substitutes for distribution-level analysis.
