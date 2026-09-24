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

## What we deliberately do not do

- Resolve dependency graphs when no lockfile exists (we say so instead).
- Execute a project's tests or build to verify usage (until the M4 isolation tier exists, and only inside it).
- Trust popularity, stars, or familiarity as safety signals.

## Reporting

See [SECURITY.md](../SECURITY.md).
