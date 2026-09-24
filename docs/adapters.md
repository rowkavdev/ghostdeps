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
- **Evidence or silence.** Usage findings carry file and line. Missing
  lockfiles produce `incomplete` graphs and reduced confidence, never
  resolution.
- **Monorepo-native.** Results are per `ProjectRef`, not repo-wide guesses.

## Status

| Adapter                            | Ecosystem                                    | Status                                                                                       |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@ghostdeps/javascript-typescript` | JavaScript/TypeScript (npm, pnpm, Yarn, Bun) | in progress: ecosystem detection (#24), import usage scanning (#28); parsing, graphs to come |
| (none yet)                         | Python, Rust, Go                             | contracts only - implementations start from the M1/M2 issues                                 |

New adapters: read [contributing-adapters.md](contributing-adapters.md).
