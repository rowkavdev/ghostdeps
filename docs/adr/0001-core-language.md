# ADR 0001: Core language and implementation stack

- Status: Accepted
- Date: 2026-09-24

## Context

GhostDeps is a GitHub App and a CLI sharing one analysis engine, with per-ecosystem adapters (JavaScript/TypeScript, Python, Rust, Go, then more). The core language choice constrains everything: the GitHub App framework, the static-analysis libraries available for each ecosystem, CLI distribution, type safety of the shared contracts, and the contributor pool.

Requirements from the product spec:

- first-class GitHub integration (webhooks, Checks API)
- strong static-analysis ecosystem, especially for JS/TS first
- easy adapter development by outside contributors
- cross-platform CLI distribution
- strong type safety
- good performance, but architecture quality over raw speed

## Decision

**TypeScript on Node.js 22 LTS, as a pnpm monorepo.**

Concretely:

- **Language:** TypeScript, strict mode, ESM throughout.
- **Runtime:** Node.js 22 LTS (the CLI engines floor). Node 22 gives native `fetch`, `structuredClone`, `crypto.randomUUID` — several of the same native capabilities GhostDeps itself recommends — with no polyfills.
- **Package manager:** pnpm workspaces. Packages: `core`, `adapters/*`, `cli`, `github-app`.
- **GitHub App framework:** Probot (see ADR 0003).
- **JS/TS source analysis:** the TypeScript compiler API for module resolution and import graphs in the JS/TS adapter.
- **Other languages' source analysis:** tree-sitter (via Node bindings) for import/usage scanning of Python, Rust and Go — grammars are maintained, incremental, and never execute target code.
- **Tests:** Node.js `node:test` (see amendment below). **Lint/format:** ESLint (flat config) + Prettier.
- **CLI distribution:** npm (`npx ghostdeps`) first; single-binary builds (via `node --experimental-sea` or pkg-style bundling) deferred until distribution matters.

## Alternatives considered

**Go.** Excellent CLI distribution (single static binary) and performance; `go-github` is solid. Rejected: the first production ecosystem is JavaScript/TypeScript, and high-fidelity JS/TS analysis from Go means embedding or shelling out to a JS parser anyway — the dominant analysis workload would live in a second runtime. Smaller pool of casual OSS contributors than TypeScript for a dev-tool of this shape.

**Rust.** Best-in-class performance and packaging (cargo-dist). Rejected: same second-runtime problem for JS/TS analysis, slower iteration on a research-heavy, schema-evolving codebase, and a steeper bar for drive-by contributors writing ecosystem adapters.

**Python.** Natural for the Python adapter and rich parsing (ast, importlib). Rejected: weak GitHub App ecosystem compared to Octokit/Probot, painful CLI distribution, and no meaningful static typing story for contracts shared across many contributors without significant discipline.

**Polyglot core (each adapter in its own language).** Rejected explicitly by the product spec: one analysis engine, one shared contract, no per-language reimplementation of the core. Adapter _analysis helpers_ may still shell out to ecosystem tools later inside sandboxing (ADR 0004), but the contract boundary stays TypeScript.

## Consequences

- Node must be present for the CLI until single-binary builds exist; acceptable for a developer tool distributed via npm.
- tree-sitter native bindings must build on contributors' machines; prebuilt binaries cover the common platforms, and the JS/TS adapter (compiler API, pure JS) works without them.
- pnpm is a contributor prerequisite; documented in CONTRIBUTING.md and enforced via `packageManager` in package.json (corepack).
- Monorepo tooling stays minimal on purpose: pnpm workspaces + tsc project references, no Nx/Turborepo until there is demonstrable need.

## Amendment (2026-09-24): test runner

Vitest is replaced by Node's built-in `node:test` runner. pnpm 12 requires interactive approval for dependency build scripts, and Vitest's esbuild chain could not be approved non-interactively in our CI/dev environments. `node:test` needs zero additional dependencies, which also matches the project's own rule: don't take a dependency you don't need. If we outgrow it (snapshot testing, browser DOM), revisit with a dedicated ADR.
