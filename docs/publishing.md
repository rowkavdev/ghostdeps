# Publishing the `ghostdeps` npm package

The CLI ships on npm as a single unscoped package, `ghostdeps`. This document
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
2. Tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The Release workflow builds, tests, stages, prints the tarball contents
   (`npm pack --dry-run`) and publishes with `--provenance`.

`workflow_dispatch` runs the same pipeline but always publishes with
`--dry-run`, for rehearsing a release without shipping it.

## Trusted publishing (OIDC), and the first-publish exception

Releases authenticate with npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers-for-2fa-and-gat-management/):
no long-lived npm token anywhere, and provenance attestations come free. This
matters because npm is deprecating the granular-access-token 2FA bypass used
by legacy token-based CI publishing.

Chicken-and-egg: npm only lets you configure a trusted publisher for a
package that already exists. So:

1. **First publish (v0.1.0) is manual**, from a maintainer machine:
   `pnpm install --frozen-lockfile && pnpm build && pnpm test`,
   `node scripts/stage-npm.mjs --version 0.1.0`, then
   `cd .npm-staging && npm publish --access public` (interactive npm login,
   email OTP until 2FA is enrolled).
2. On npmjs.com: package settings → Trusted Publisher → GitHub Actions,
   repository `rowkavdev/ghostdeps`, workflow `release.yml`.
3. Every later release is just the tag push above; the workflow's OIDC token
   does the auth.

## Versioning

Single package, version comes from the git tag - the tag is the source of
truth. Pre-releases use normal semver prerelease tags (`v0.2.0-rc.1`).
