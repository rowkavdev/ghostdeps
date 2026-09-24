# ADR 0004: Analysis sandboxing and untrusted-code policy

- Status: Accepted
- Date: 2026-09-24

## Context

GhostDeps checks out and analyses arbitrary third-party repositories. Every byte of a target repository — manifests, lockfiles, source, config, filenames, symlink structure — is attacker-controlled. A dependency-analysis tool is itself a supply-chain target: compromise it and you inherit every installation's tokens. The spec is explicit: repository analysis must not casually execute repository code, prefer static analysis, and treat all repository content as untrusted input.

## Decision

**GhostDeps never executes repository code. Analysis is static-only, and any future step that must run tooling does so inside a defined isolation tier.**

The policy, in enforceable terms:

1. **No execution, period.** No `npm install`, `pip install`, `cargo build`, `go mod download` inside the service. No package lifecycle scripts, no build scripts, no `postinstall`. Lockfiles and manifests are parsed as data. Resolution facts come from lockfiles; when a lockfile is absent, GhostDeps reports reduced confidence rather than resolving.
2. **Everything is parsed, nothing is evaluated.** Manifests with executable surfaces (e.g. `pyproject.toml` is fine; a `setup.py` is code) are handled by static extraction or reported as unanalysable — never imported, never run.
3. **Checkout is inert.** Tarball download only (ADR 0003). Symlinks are not followed outside the extraction root; archive entries are validated (path traversal, absolute paths, link targets) before write. Size and file-count ceilings apply.
4. **Parser hardening.** All parsers run with input size limits and timeouts. Malformed input produces a finding of reduced confidence, not a crash.
5. **Registry metadata is server-side and cached.** Adapters never make network calls (ADR 0002's `NetworkPolicy`). The core metadata service talks to npm/PyPI/crates.io/pkg.go.dev with response caching, and the CLI works offline without it.
6. **Isolation tiers for the future.** If a capability genuinely requires running ecosystem tooling (e.g. exact graph resolution in M3+, patch verification in M4), it runs in a disposable container with: no network by default, read-only root, dropped capabilities, CPU/memory/time limits, `--ignore-scripts` equivalents, and an ephemeral filesystem. That design is a separate ADR before any such code lands. Nearer term, adapter analysis runs in worker threads with heap limits and preemptive `terminate()` on stage timeout (#90, docs/analysis-engine.md); the in-process tier's stage timeouts still bound async waits only.
7. **Secrets hygiene.** Analysis workers hold only the installation token they need, scoped to the repository being analysed, minted per job. No long-lived tokens near checkouts.

## Alternatives considered

**Execute installs with `--ignore-scripts` in the main service.** Rejected: script flags are one bypass away from disaster, dependency resolution itself runs registry-controlled code paths in some ecosystems, and the blast radius includes our GitHub App credentials.

**MicroVM sandboxing (Firecracker/gVisor) from day one.** Right answer for the wrong time: v0.1–M3 needs no execution at all. The tiered policy keeps the door open without paying the complexity now.

**Trust popular repositories.** Rejected outright. Popularity is not a security boundary; account takeovers and protestware target exactly the popular set.

## Amendment (2026-09-24): symlinks are recorded, never materialised

Point 3 originally validated link targets and created root-confined links on disk. Independent review of the first extractor found two resolution-order escapes (lexical vs physical `..` handling; targets resolved at link-creation time changing meaning as later links land). The decision is amended: extraction **never creates symlinks**. Link entries are validated as paths and recorded in the extraction summary for the `RepositoryHandle`; nothing on disk can be followed, which removes the entire escape class rather than patching resolution order. Hardlinks remain materialised but may only reference files already extracted inside the root.

## Consequences

- Some questions ("exact transitive closure without a lockfile") are intentionally unanswered rather than unsafely answered; the product reports reduced confidence instead.
- Fixture and adversarial-testing work must include hostile fixtures: path-traversal archives, symlink bombs, malformed manifests, huge lockfiles.
- Any PR introducing a code path that spawns processes against repository content is a security-review blocker by definition.
