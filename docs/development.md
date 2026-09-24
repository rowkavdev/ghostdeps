# Development

## Prerequisites

- Node.js 22+ (24 supported; CI tests both)
- pnpm via corepack: `corepack enable` (the repo pins the pnpm version in `package.json`)

## Everyday commands

```bash
pnpm install        # install workspace dependencies
pnpm build          # build all packages (tsc project references)
pnpm test           # run all package tests (Vitest)
pnpm lint           # ESLint (flat config)
pnpm format         # Prettier write
pnpm typecheck      # tsc --noEmit across packages
```

All of these run in CI on Node 22 and 24; nothing merges on red.

## Conventions

- TypeScript strict mode, ESM, `NodeNext` resolution. Import types with `import type`.
- Prettier and EditorConfig own formatting; don't fight them.
- Tests live next to source (`*.test.ts`); fixture repositories live in `fixtures/` and are excluded from lint/format.
- Dependencies: think twice before adding one. This is GhostDeps — we are the tool that tells people they don't need a dependency. Every new dependency in this repo needs a sentence of justification in its PR.

## Dependency updates

Renovate keeps dependencies current (see `renovate.json`). Release/versioning strategy: pre-1.0 the packages stay private; public npm publishing and Changesets arrive with the first usable CLI milestone (M1).
