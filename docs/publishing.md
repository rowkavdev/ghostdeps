# Publishing the `ghost-deps` npm package

The CLI ships on npm as `ghost-deps`. It previously shipped scoped as `@rowkav09/ghostdeps`; the unscoped `ghostdeps` name was tried and definitively rejected by the registry similarity rule (2026-09-27), so the canonical name is `ghost-deps`, which Rowan owns outright. After the rename publish, both `@rowkav09/ghostdeps` and the old `ghost-deps` lineage converge: `@rowkav09/ghostdeps` becomes a deprecated pointer at `ghost-deps`. This document
is the release process and the reasoning behind the layout.

## Layout

The release workflow stages one CLI-only tarball with
`scripts/stage-dist-prototype.mjs` from the built workspace. It copies emitted
JavaScript into `dist/`, rewrites internal workspace imports to resolved relative
files, and omits type declarations and unpublished `@ghostdeps/*` dependencies.
The worker remains a real file and uses fixed adapter-entry wrappers. Rust's
`tree-sitter-rust` grammar and `web-tree-sitter` runtime/WASM remain vendored to
avoid the native tree-sitter peer install. `typescript`, `yaml`, and `smol-toml`
remain published registry dependencies.

The tag release packs this stage **once**. It passes that tarball (not a rebuilt
copy) to clean npm and Bun consumer tests on Ubuntu and Windows, Node 22/24.
Each consumer checks the tarball hash, scans four ecosystem fixtures, runs the
isolated worker and Rust parser, and repeats after prune and reinstall. The
publish job checks the same hash and publishes the tested tarball with npm
trusted publishing and provenance. A failed consumer test blocks publishing.

## Cutting a release

1. Land everything on main, green CI and green staged-consumer checks.
2. Tag the next unclaimed version: `git tag v0.1.N && git push origin v0.1.N`.
3. The Release workflow builds, tests, packs one staged tarball, runs the
   consumer matrix and publishes the exact tarball with `--provenance`.

`workflow_dispatch` uses the same gates but always publishes with `--dry-run`.
The current PR for this release switch must not merge until Rowan explicitly
approves changing the published artifact. Do not describe Bun as supported
before the release gate itself succeeds on the artifact that users install.

## Trusted publishing (OIDC), and the first-publish exception

Releases authenticate with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/):
no long-lived npm token anywhere, and provenance attestations come free. This
matters because npm is deprecating the granular-access-token 2FA bypass used
by legacy token-based CI publishing.

Chicken-and-egg: npm only lets you configure a trusted publisher for a
package that already exists. So each new package name bootstraps manually:

1. **First publish of `@rowkav09/ghostdeps` (v0.1.0) is done** (2026-09-27): staged from a maintainer
   machine with `node scripts/stage-npm.mjs --version 0.1.0` and published
   from `.npm-staging` with `npm publish --access public` using a short-lived
   access token. The npm account now uses a security key for 2FA; no
   long-lived token remains.
2. **Trusted-publisher connection is live for `@rowkav09/ghostdeps`** (verified 2026-09-27): package
   settings → Trusted Publisher → GitHub Actions, repository
   `rowkavdev/ghostdeps`, workflow `release.yml`. Tag pushes are set up to
   authenticate via the workflow's OIDC token; the first tag publish remains
   to be verified. The rolling cadence below runs on this path.

## Versioning

Single package, version comes from the git tag - the tag is the source of
truth.

**Rolling patch cadence (Rowan's rule, 2026-09-27):** every small shippable
change bumps the patch version and goes out - from 0.1.0 the next releases
are 0.1.1, 0.1.2, and so on. One rolling release line, no sitting on
unreleased work: when a shippable change lands green on main, tag `v0.1.N`
and push; release.yml is set up to publish via the OIDC trusted-publisher
path - verified on the 0.1.1-0.1.4 line.

The rename to `ghost-deps` repeated the bootstrap once: the first `ghost-deps`
publish (0.1.6, 2026-09-27) was manual (short-lived token, `--access public`),
then the trusted publisher was configured on the new package name (repository
`rowkavdev/ghostdeps`, workflow `release.yml`) and tag pushes take over. The
unscoped `ghostdeps` name is off the table - the registry similarity rule
rejected it against `ghost-deps` even with Rowan owning both.
Minor/major bumps are reserved for changes that are not small. Pre-releases
use normal semver prerelease tags (`v0.2.0-rc.1`).
