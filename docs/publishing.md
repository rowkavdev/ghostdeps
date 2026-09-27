# Publishing the `@rowkav09/ghostdeps` npm package

The CLI ships on npm as a scoped package, `@rowkav09/ghostdeps` (the unscoped name is blocked by the registry similarity rule). This document
is the release process and the reasoning behind the layout.

## Layout

`scripts/stage-npm.mjs` assembles `.npm-staging/` from a built workspace:

- the CLI's compiled `dist/` becomes the package root (`bin.ghostdeps`);
- the built `@ghostdeps/*` workspace packages are vendored under
  `node_modules/@ghostdeps/*` (listed in `bundledDependencies`), keeping
  their names and `exports` so bare-specifier imports resolve exactly as in
  the workspace;
- `tree-sitter-rust` and `web-tree-sitter` are vendored too. `tree-sitter-rust`
  declares a peer on the native `tree-sitter` package, which npm would
  auto-install and node-gyp-build on every user machine (#50, #63) - only its
  `.wasm` grammar is needed, so the wasm ships vendored instead;
- `typescript`, `yaml` and `smol-toml` stay normal registry dependencies,
  pinned to the versions the adapters declare.

Vendoring instead of esbuild/tsup bundling: the engine spawns workers via
`new Worker(new URL("./adapter-worker.js", import.meta.url))` and loads
adapters with dynamic `import(specifier)`, and the Rust adapter resolves its
grammar with `require.resolve("tree-sitter-rust/tree-sitter-rust.wasm")`.
All three need real on-disk modules, so single-file bundling is out.

## Cutting a release

1. Land everything on main, green CI.
2. Tag the next unclaimed version: `git tag v0.1.1 && git push origin v0.1.1`.
3. The Release workflow builds, tests, stages, prints the tarball contents
   (`npm pack --dry-run`) and publishes with `--provenance`.

`workflow_dispatch` runs the same pipeline but always publishes with
`--dry-run`, for rehearsing a release without shipping it.

## Trusted publishing (OIDC), and the first-publish exception

Releases authenticate with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/):
no long-lived npm token anywhere, and provenance attestations come free. This
matters because npm is deprecating the granular-access-token 2FA bypass used
by legacy token-based CI publishing.

Chicken-and-egg: npm only lets you configure a trusted publisher for a
package that already exists. So the first publish bootstrapped manually:

1. **First publish (v0.1.0) is done** (2026-09-27): staged from a maintainer
   machine with `node scripts/stage-npm.mjs --version 0.1.0` and published
   from `.npm-staging` with `npm publish --access public` using a short-lived
   access token. The npm account now uses a security key for 2FA; no
   long-lived token remains.
2. **Trusted-publisher connection is live** (verified 2026-09-27): package
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
and push; release.yml publishes it via the OIDC trusted-publisher path.
Minor/major bumps are reserved for changes that are not small. Pre-releases
use normal semver prerelease tags (`v0.2.0-rc.1`).
