# Ecosystem adapters

GhostDeps analyses arbitrary ecosystems through adapters implementing the
contract in `packages/core/src/adapter.ts`. ADR 0002 is the authority.

## What an adapter is

An adapter answers factual questions about one ecosystem: is it present
(`detect`), what is declared (`listDirectDependencies`), what does the
transitive graph look like (`buildDependencyGraph`), where and how is a
dependency used (`findUsage`), what native alternatives exist
(`findNativeAlternatives`), what are the factual health signals
(`analyseHealth`). Adapters never decide what a user should do -
recommendation policy lives in core.

## Contract highlights

- **Two-phase detection.** `detect()` returns 0..1 confidence plus evidence.
  A manifest without meaningful source scores below threshold and the
  ecosystem is skipped.
- **Explicit capabilities.** Declare exactly what you implement; core
  degrades gracefully. The contract tests verify declarations match reality.
- **No direct I/O.** Adapters receive a read-only `RepositoryHandle` and a
  `NetworkPolicy`. Registry metadata comes from core's metadata service.
- **Complete or conservative.** `findUsage` returns `Usage[]` or
  `{ usages, referenceAnalysisComplete }`. Set `referenceAnalysisComplete: true`
  only when every script, bin and config reference to the dependency was
  checked. An array, an omitted flag or `false` all count as incomplete, and
  the policy then never calls the dependency "unused".
- **Evidence or silence.** Usage findings carry file and line. Missing
  lockfiles produce `incomplete` graphs and reduced confidence, never
  resolution.
- **Notes, never caps (#205).** The optional `notes(context, projects)`
  runs after the graph and usage stages and returns `{ statement, dependency? }[]`.
  A note with `dependency` (a name this adapter listed) is a capability note:
  core emits it as an `adapter-capability` awareness finding. A note without
  one is a run-level note: core emits it as an `adapter-note` in Notes
  (`adapterNote: true`). Neither caps verdicts, confidence or severity, so
  never use a note for missing coverage. Coverage gaps that should cap stay
  engine-owned (scan completeness, #154). Output is untrusted: malformed
  notes and unknown dependencies are dropped, statements are cleaned and cut
  to 300 characters, duplicates are merged, and a run keeps at most 100
  notes. If `notes` throws, times out, or kills its worker, the analysis is kept and one incomplete note says the notes were lost. Additive,
  so there's no `adapterApiVersion` bump.
- **Monorepo-native.** Results are per `ProjectRef`, not repo-wide guesses.

## Status

| Adapter                            | Ecosystem                                    | Status                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ghostdeps/javascript-typescript` | JavaScript/TypeScript (npm, pnpm, Yarn, Bun) | detection (#24), package-manager detection (#25), manifest parsing (#26), lockfile graphs (#27), usage scanning (#28); fixtures (#30) adds the scenario set                                                                                                                                                    |
| `@ghostdeps/rust`                  | Rust (Cargo)                                 | detection and Cargo.toml parsing incl. workspaces and feature flags (#49), Cargo.lock graphs and tree-sitter usage scanning (#50); fixtures (#51)                                                                                                                                                              |
| `@ghostdeps/go`                    | Go (modules)                                 | go.mod parsing and detection incl. go.work/vendor, edgeless module graph marked incomplete (#52), import usage scanning (#53); fixtures (#54); never reports unused in M2                                                                                                                                      |
| `@ghostdeps/python`                | Python (pip, Poetry, uv, Pipenv, PDM)        | detection (#42), pyproject.toml parsing incl. PEP 621/735 and Poetry groups (#43), requirements files with includes/constraints (#44), uv.lock/poetry.lock graphs incl. uv workspaces (#45), import-name mapping (#46); PEP 735 dependency groups count as dev; no usage scanning yet, so never reports unused |

New adapters: read [contributing-adapters.md](contributing-adapters.md).

## Poetry extras membership

When an optional Poetry dependency appears in several `tool.poetry.extras`
lists, its Python requirement records every declaring extra in `groups`.
Repeated members do not create duplicate dependencies or group names. This
also applies to runtime dependencies declared in `tool.poetry.group.main`.

## Python dynamic import literals

Literal module names in `importlib.import_module` and `__import__` calls
can be positional or supplied as a reordered `name` keyword. Parentheses
around the whole literal do not change its value. String placeholders are
chosen per file so source identifiers cannot impersonate literal tokens.

Supported Python escapes are decoded statically, without executing source;
raw strings retain backslashes and byte strings are not module names.
Named Unicode escapes, adjacent string concatenation and executable f-string
fields remain unsupported. Tuples, arithmetic and conditional expressions
are not treated as constant module names. Relative imports with a known
positive `__import__` level still receive no external usage credit.

## Python namespace import mapping

The Python import-name table maps `zope.i18nmessageid`, `zope.security`,
`zope.deprecation` and `zope.proxy` (including their child modules) to the
matching declared distributions. An undeclared distribution, the bare
`zope` root or an unknown child of that root stays unresolved. These entries
are checked against the published wheels; scanning does not install them.
