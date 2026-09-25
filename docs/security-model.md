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
2. **Checkouts are inert.** Codeload tarballs only. Archive entries are validated before extraction: no path traversal, no absolute paths. **Symlinks are never materialised** - they are recorded as metadata (path + raw target) for the `RepositoryHandle`, so nothing on disk can be followed into or out of the root. Hardlinks may only reference files already extracted inside the root. Size and file-count ceilings enforced.
3. **Parsers are hardened entry points.** Strict input limits and timeouts; malformed input degrades confidence instead of crashing; no `eval`, no dynamic import of repository content, ever.
4. **Adapters have no network.** Registry metadata flows only through the core metadata service with caching and timeouts. CLI static analysis works fully offline.
5. **Tokens are minimal and short-lived.** Per-job installation tokens scoped to the target repository. Least-privilege app permissions (see docs/github-app.md). No tokens inside analysis sandboxes beyond what the job needs.
6. **Findings are data.** Report rendering never injects repository content into executable contexts (annotation text is plain; CLI output is escaped).
7. **Hostile fixtures are first-class tests.** Traversal archives, symlink loops, giant lockfiles, malformed manifests and Unicode tricks live in `fixtures/` and run in CI.

## Outbound network from the GitHub App

Besides GitHub, the app's worker makes one kind of outbound request, and only when install footprints are turned on (`GHOSTDEPS_FOOTPRINT`, off by default): read-only `GET`s to the public npm registry (`registry.npmjs.org`) for the install sizes of exact package versions (#174).

- **What is queried:** only name@version pairs whose lockfile evidence says they came from the public npm registry. Core passes each locked version's `origin` (from the adapter's `GraphNode.registryOrigin`, validated by core as a plain http(s) origin), and the provider queries only versions whose origin is one of exactly two public origins in core's `PUBLIC_NPM_REGISTRY_ORIGINS`: `https://registry.npmjs.org` or `https://registry.yarnpkg.com` (yarn classic's mirror of the public npm set). The allowlist is exact and never matched by suffix, subdomain or wildcard, and both the js adapter's origin derivation and the provider read it from core (`isPublicNpmRegistryOrigin`), never from a copy. The request always goes to `GET https://registry.npmjs.org/<name>/<version>`. Adapters set an origin only from a resolved URL in the lockfile, or from a scoped registry binding (e.g. `@acme:registry=...`) that unambiguously matches the package's scope. A default `registry=` setting is not evidence of where a package came from, so the rule is the same across package-lock, yarn and pnpm lockfiles.
- **What is never sent:** everything else is skipped silently, with no footprint, no cap and no note (ADR 0004, fail-closed): private registries, mirrors, git, file, link and workspace packages, disagreeing nodes, and any package without an origin. pnpm packages without scoped .npmrc bindings receive no footprint - see github-app.md. So a private package name never leaves the worker, and a registry 404 can't reveal whether it exists. No credentials, never a GitHub token, no repository contents, paths or identifiers. Redirects are refused.
- **Validation and bounds:** names and versions come from untrusted lockfiles, so they are checked against npm name syntax and exact semver before they reach a URL. Requests are bounded by an LRU cache, a per-run request budget, per-request and per-run timeouts, and a 1 MiB cap enforced on the streamed response body. A registry answer is only a number. It can make a footprint wrong or missing, but footprints are advisory and never change a check conclusion. Every failure leaves the footprint unavailable. Adapters still have no network (rule 4).

### Registry metadata service (#60)

The app now routes through a per-ecosystem metadata service, but **npm is the only registered fetcher**. The CLI still supplies no metadata provider and works offline. An unknown ecosystem, missing origin, private registry, or unproven resolution never makes a request. The npm fetcher uses core's exact `PUBLIC_NPM_REGISTRY_ORIGINS` and `isPublicNpmRegistryOrigin`, never a copied allowlist. No PyPI, crates.io or Go egress exists in v1.

When health facts are requested, the same public-resolution rule permits an additional unauthenticated, read-only `GET https://registry.npmjs.org/<name>` for the package packument. Its `time[exactVersion]` gives `publishedAt`; `versions[exactVersion].deprecated` gives a deprecation flag when it is a string. The optional `latestVersion` and `repositoryArchived` facts are not filled in v1: npm does not establish repository archival status, and no repository-host egress is added. No release-cadence series is promised in v1. Each returned fact cites its npm field as `basis`; missing/malformed/oversized data yields no fact, never a guess. URL name/version validation, disabled redirects, 1 MiB streamed response cap, 3 s request timeout, 8 s run deadline and per-run 300-request shared budget apply to health too. Only the public package name leaves the worker; no token, repository details or private package name are sent. This metadata cannot change a check conclusion by itself.

Caches are bounded process-local LRUs: npm size and health facts use a canonical name + exact-version path as key, each expiring after 24 hours (including known misses); complete footprint answers use SHA-256 of ecosystem and sorted origin/name/version tuples, expiring after one hour. Transient errors and truncated answers are not cached. These TTLs trade staleness for rate control; a restart empties them. No user or installation is part of a cache key because only proven public packages reach the fetcher. A new ecosystem fetcher requires an explicit per-ecosystem origin allowlist and a matching security review before registration.

## What we deliberately do not do

- Resolve dependency graphs when no lockfile exists (we say so instead).
- Execute a project's tests or build to verify usage (until the M4 isolation tier exists, and only inside it).
- Trust popularity, stars, or familiarity as safety signals.

## Reporting

See [SECURITY.md](../SECURITY.md).
