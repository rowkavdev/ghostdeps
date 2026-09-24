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

| Adapter                            | Ecosystem                                    | Status                                                                                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ghostdeps/javascript-typescript` | JavaScript/TypeScript (npm, pnpm, Yarn, Bun) | detection (#24), package-manager detection (#25), manifest parsing (#26), lockfile graphs (#27), usage scanning (#28); fixtures (#30) adds the scenario set                                                                                                                         |
| `@ghostdeps/rust`                  | Rust (Cargo)                                 | detection and Cargo.toml parsing incl. workspaces and feature flags (#49), Cargo.lock graphs and tree-sitter usage scanning (#50); fixtures (#51)                                                                                                                                   |
| `@ghostdeps/go`                    | Go (modules)                                 | go.mod parsing and detection incl. go.work/vendor, edgeless module graph marked incomplete (#52), import usage scanning (#53); fixtures (#54); never reports unused in M2                                                                                                           |
| `@ghostdeps/python`                | Python (pip, Poetry, uv, Pipenv, PDM)        | detection (#42), pyproject.toml parsing incl. PEP 621/735 and Poetry groups (#43), requirements files with includes/constraints (#44), uv.lock/poetry.lock graphs incl. uv workspaces (#45); PEP 735 dependency groups count as dev; no usage scanning yet, so never reports unused |

New adapters: read [contributing-adapters.md](contributing-adapters.md).
