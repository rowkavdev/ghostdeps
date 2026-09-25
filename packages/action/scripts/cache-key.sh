#!/usr/bin/env bash
# Immutable content identity for the ghostdeps build the action runs (#347):
# one hash over the lockfile, workspace config, and every source/manifest
# file of the packages the action builds and runs. Works on a plain action
# download (no .git - remote `uses:` downloads have none). Exits 1 when the
# layout is not recognisable; callers must then skip the cache entirely
# (fail-closed: never cache under an unknown identity).
set -euo pipefail
root=${1:?usage: cache-key.sh <action-root>}
cd "$root"
# Every root-level build input must feed the identity: the lockfile and
# workspace config, plus tsconfig.base.json (extended by every built package)
# and package.json (packageManager pins the pnpm version; root scripts drive
# the build). A change to any of these must bust the cache.
for f in pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json package.json; do
  [ -f "$f" ] || exit 1
done
dirs=(packages/core packages/cli packages/action packages/checks-renderer packages/adapters)
for d in "${dirs[@]}"; do [ -d "$d" ] || exit 1; done
{
  sha256sum pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json package.json
  find "${dirs[@]}" -type f \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    -not -name '*.tsbuildinfo' \
    -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
} | sha256sum | cut -c1-32
