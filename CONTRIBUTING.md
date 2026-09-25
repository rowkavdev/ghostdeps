# Contributing to GhostDeps

Thanks for helping build GhostDeps. This project treats outside contributors as first-class from day one, so this document is written for you, not as an afterthought.

## Ground rules

1. **Every change goes through a pull request.** No direct pushes to `main`.
2. **Small, focused PRs.** One concern per PR. If a change is getting big, split it.
3. **Link an issue.** Every PR references the issue it closes (`Closes #123`).
4. **Tests travel with code.** New behaviour lands with tests in the same PR.
5. **Docs travel with code.** If you change behaviour, update the relevant doc in `docs/` in the same PR.
6. **Green CI or it doesn't merge.** All checks must pass.


## Merge protocol

The merge gate keeps `main` green and every merge verdict auditable.

1. **Approval names the head.** A pull request merges only after a reviewer posts an APPROVE comment naming the current head SHA. Any new push resets the verdict.
2. **Green at the approved head, no rebase.** All CI checks must pass at that exact SHA and GitHub must report the PR mergeable; merge green and approved without rebasing. A rebase is a new head, so it resets the gate like any other push.
3. **Squash merge.** Squash-merge pinned to the approved SHA.
4. **Post-merge gate: latest containing green.** Main CI is the integration check. When a merge's own CI run is cancelled by concurrency supersession, the latest containing main commit going green is sufficient as the post-merge gate - no exact-SHA rerun - under three conditions: (a) containment: the green run's commit descends from the cancelled run's merge SHA; (b) same matrix: the containing run executes the same full job set, so a lint/typecheck-only run never counts; (c) red reopens: if the containing run fails, rerun the intermediate SHA to bisect which merge introduced the failure. Green closes; red bisects. Cancellation by supersession is a CI scheduling artifact, not a signal.
5. **Board hygiene on merge.** Close the linked issue and move its card to **Done**.

## Development setup

Requires Node.js 22+ and pnpm (via `corepack enable`).

```bash
git clone https://github.com/rowkavdev/ghostdeps.git
cd ghostdeps
pnpm install
pnpm test
pnpm lint
pnpm typecheck
```

## Project layout

GhostDeps is a pnpm monorepo:

```text
packages/
  core/        shared types, dependency model, adapter interface, analysis engine
  adapters/    one package per ecosystem (javascript-typescript, python, rust, go, ...)
  cli/         the ghostdeps command-line interface
  github-app/  the GitHub App (webhooks, checks, annotations)
fixtures/      representative test repositories used by the test suites
docs/          architecture docs, ADRs, guides
```

The same analysis engine powers the CLI and the GitHub App. There is no second implementation.

## Finding work

The [project board](https://github.com/orgs/rowkavdev/projects) is the source of truth. Issues in **Ready** are unblocked and scoped; comment on one to claim it before starting. If you spot missing work, open an issue with a goal and done-criteria rather than a vague title.

## Architecture decisions

Consequential technical choices are recorded as ADRs in [docs/adr/](docs/adr/). If your PR changes or reverses a decision, update or supersede the ADR in the same PR.

## Ecosystem adapters

New ecosystems are added as adapters implementing the contract in `packages/core`. Read [docs/contributing-adapters.md](docs/contributing-adapters.md) before starting one. Every adapter must pass the shared adapter contract tests and ship fixtures.

## Style

- TypeScript, strict mode, ESM.
- Prettier formats, ESLint lints. Both run in CI; run `pnpm format` before pushing.
- Descriptive commit messages: what changed and why, not "fix stuff".

## Reporting security issues

See [SECURITY.md](SECURITY.md). Never open a public issue for a vulnerability.
