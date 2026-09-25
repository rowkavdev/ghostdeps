# GhostDeps security model

GhostDeps analyses untrusted repositories. This document is the threat model and the rulebook; ADR 0004 records the decision, this file is the living reference reviewers and contributors check against.

## Assets at risk

- **GitHub App credentials and installation tokens** — compromise grants access to every installed repository.
- **Analysis integrity** — a repo that can corrupt our parser can fabricate or suppress findings on itself and others.
- **Service availability** — a hostile repo that hangs or OOMs analysis degrades every installation.
- **User trust** — a tool that can be made to execute attacker code becomes a supply-chain vector into every consumer.

## Attacker capabilities

Assume the author of an analysed repository is malicious and controls: all file contents (manifests, lockfiles, source, configs), filenames and directory structure including symlinks and encodings, PR diffs and titles, and package metadata on public registries.

## Rules

1. **Repository code is never executed.** No installs, no builds, no lifecycle scripts, no evaluation of executable manifest surfaces (e.g. `setup.py`). Facts come from static parsing; missing facts lower confidence.
2. **Checkouts are inert.** GitHub codeload tarballs only; no git clone. Archive entries are validated before extraction: no path traversal, no absolute paths. **Symlinks are never materialised** - they are recorded as metadata (path + raw target) for the `RepositoryHandle`, so nothing on disk can be followed into or out of the root. Hardlinks may only reference files already extracted inside the root. Size and file-count ceilings are enforced. The download has a 512 MiB compressed-byte ceiling and a 5 minute timeout (`worker/tarball.ts`, `worker/analyse-job.ts`); extraction defaults to 200,000 entries, 1 GiB decompressed archive and extracted file total, and 256 MiB per file (`core/checkout/extract.ts`). The subsequent scan defaults to 50,000 files and 512 MiB listed bytes (`core/engine/scanner/limits.ts`).
3. **Parsers are hardened entry points.** File and lockfile read limits and adapter-stage timeouts apply; malformed input degrades confidence instead of crashing; no `eval` or dynamic import of repository content as a module. The app uses `analyseRepositoryIsolated`: each adapter runs in a Node worker thread with a default 512 MiB **old-generation JavaScript heap** limit and a watchdog that terminates an over-time stage (`core/engine/isolated.ts`). Up to four adapters run concurrently by default. This is a worker-thread limit, not a whole-process, native-memory or operating-system sandbox. In particular, tree-sitter WASM memory is not counted by the 512 MiB old-generation heap limit. The Rust parser frees each parsed tree in a `finally` block (`adapters/rust/src/parser.ts`), but native/WASM and parent-process peak memory still need separate operational bounds. A future process/container isolation tier must not be represented as already shipped.
4. **Analysis is offline by default.** The app does not give adapters a network policy or GitHub tokens. Its optional npm metadata provider stays in the parent and is called through the core metadata interface, with caching and timeouts. CLI static analysis works offline by default. Worker threads are not OS-level network-isolated: an imported adapter module could call Node network APIs. Adapter module specifiers are trusted configuration, not repository input; repository-contained paths and relative specifiers are rejected by `core/engine/isolated.ts`. Do not describe this as an enforced no-network sandbox.
5. **Tokens are scoped, but analysis is in-process.** The worker mints an installation token per job scoped to the target repository and to `contents: read` + `checks: write` (`github-app/worker/github-client.ts`). The App requests `contents: read`, `pull_requests: read`, `checks: write`, and mandatory `metadata: read` (`github-app/app.yml`, [GitHub App operations](github-app.md)). The token is held by the app-side job client, not passed into adapter worker options. Those Node workers still share the service process: the private key and token are not protected by a separate process/container boundary. Webhook changed-file lookups use a general installation client, not the per-job restricted token (`github-app/app.ts`).
6. **Findings are data.** Report rendering never injects repository content into executable contexts (annotation text is plain; CLI output is escaped).
7. **Hostile fixtures are first-class tests.** Traversal archives, symlink loops, giant lockfiles and malformed manifests are tested in `packages/core/src/checkout/`, `packages/core/src/engine/scanner/` and the adapters. Keep adding adversarial cases to CI.

## Outbound network from the GitHub App

The app uses the GitHub API for jobs and check runs and fetches checkout tarballs directly from `https://codeload.github.com` after validating the API redirect (`github-app/worker/tarball.ts`). The only optional non-GitHub-network destination in the current app implementation is the public npm registry (`registry.npmjs.org`): with `GHOSTDEPS_FOOTPRINT` enabled (off by default), the metadata provider makes read-only `GET`s for exact package-version install sizes (#174). This describes the app's code paths, not a host firewall or an enforced egress policy.

- **What is queried:** only name@version pairs whose lockfile evidence says they came from the public npm registry. Core passes each locked version's `origin` (from the adapter's `GraphNode.registryOrigin`, validated by core as a plain http(s) origin), and the provider queries only versions whose origin is one of exactly two public origins in core's `PUBLIC_NPM_REGISTRY_ORIGINS`: `https://registry.npmjs.org` or `https://registry.yarnpkg.com` (yarn classic's mirror of the public npm set). The allowlist is exact and never matched by suffix, subdomain or wildcard, and both the js adapter's origin derivation and the provider read it from core (`isPublicNpmRegistryOrigin`), never from a copy. The request always goes to `GET https://registry.npmjs.org/<name>/<version>`. Adapters set an origin only from a resolved URL in the lockfile, or from a scoped registry binding (e.g. `@acme:registry=...`) that unambiguously matches the package's scope. A default `registry=` setting is not evidence of where a package came from, so the rule is the same across package-lock, yarn and pnpm lockfiles.
- **What is never sent:** everything else is skipped silently, with no footprint, no cap and no note (ADR 0004, fail-closed): private registries, mirrors, git, file, link and workspace packages, disagreeing nodes, and any package without an origin. pnpm packages without scoped .npmrc bindings receive no footprint - see github-app.md. Under this origin policy, a private package name is not sent to the registry, and a registry 404 cannot reveal whether it exists. No credentials, never a GitHub token, no repository contents, paths or identifiers. Redirects are refused.
- **Validation and bounds:** names and versions come from untrusted lockfiles, so they are checked against npm name syntax and exact semver before they reach a URL. Requests are bounded by an LRU cache, a per-run request budget, per-request and per-run timeouts, and a 1 MiB cap enforced on the streamed response body. A registry answer is only a number. It can make a footprint wrong or missing, but footprints are advisory and never change a check conclusion. Every failure leaves the footprint unavailable. No GitHub credential is attached to a registry request (rule 4).

## What we deliberately do not do

- Resolve dependency graphs when no lockfile exists (we say so instead).
- Execute a project's tests or build to verify usage (until the M4 isolation tier exists, and only inside it).
- Trust popularity, stars, or familiarity as safety signals.

## Reporting

See [SECURITY.md](../SECURITY.md).
