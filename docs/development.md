# Development

## Prerequisites

- Node.js 22+ (24 supported; CI tests both)
- pnpm via corepack: `corepack enable` (the repo pins the pnpm version in `package.json`)

## Everyday commands

```bash
pnpm install        # install workspace dependencies
pnpm build          # build all packages (tsc project references)
pnpm test           # run all package tests (node:test)
pnpm lint           # ESLint (flat config)
pnpm format         # Prettier write
pnpm typecheck      # tsc --noEmit across packages, one at a time (#304)
```

All of these run in CI on Node 22 and 24; nothing merges on red.

## Conventions

- TypeScript strict mode, ESM, `NodeNext` resolution. Import types with `import type`.
- Prettier and EditorConfig own formatting; don't fight them.
- Tests live next to source (`*.test.ts`); fixture repositories live in `fixtures/` and are excluded from lint/format.
- End-to-end (#41): `packages/github-app/src/e2e/` delivers a recorded PR webhook to the real app with its default worker and asserts on the check run it writes. Only GitHub's HTTP API is mocked (nock). Cases live in `packages/github-app/test/e2e/<case>/` (head tree, base `package.json`, `pr.diff`, `expected-check.json`); regenerate goldens with `UPDATE_GOLDEN=1` and review the diff. It runs as part of `pnpm test`.
- Dependencies: think twice before adding one. This is GhostDeps — we are the tool that tells people they don't need a dependency. Every new dependency in this repo needs a sentence of justification in its PR.

## Dependency updates

Renovate keeps dependencies current (see `renovate.json`). Release/versioning strategy: pre-1.0 the packages stay private; public npm publishing and Changesets arrive with the first usable CLI milestone (M1).
