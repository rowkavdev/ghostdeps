# Package cost: Bundlephobia and Packagephobia

Research for [#16](https://github.com/rowkavdev/ghostdeps/issues/16). Checked against GhostDeps main on 25 September 2026.

## Problem

"Size" can mean the archive published to a registry, the installed disk footprint, or the JavaScript sent to a browser. These are not interchangeable. A dependency's transitive count and the part exclusive to it are further, graph-dependent facts.

## Existing solutions

- [Bundlephobia](https://bundlephobia.com/) estimates minified and gzipped npm bundle cost by building the package, including bundling/tool assumptions. It is useful for browser-facing decisions, but GhostDeps does not build or execute repository dependencies. A bundle number would not describe disk installation or every app's tree-shaking outcome.
- [Packagephobia](https://packagephobia.com/) reports npm publish and install sizes. Its [API guide](https://github.com/styfle/packagephobia/blob/main/API.md) documents v1/v2 JSON endpoints, caching by name and version, and asks API clients to register their site and set a matching user-agent. This is third-party size data, not a source of per-project exclusive transitive cost.

## Techniques worth retaining

Keep install size separate from browser bundle size and make the basis of each number visible. Cache immutable-version metadata, budget any network lookups and treat unavailable sizes as absent, not zero. A partial graph can support a lower bound on transitive count; it cannot prove which packages are exclusive to one direct dependency.

## Fit with GhostDeps today

Core already computes [transitive impact](../transitive-impact.md): transitive package counts, exclusive counts **only for complete graphs**, and an optional approximate install footprint. It never builds a bundle, and impact does not change recommendations or check conclusions. Footprint is a lower bound based on sized locked packages with explicit coverage; when metadata is missing, the field is omitted.

The [GitHub App](../github-app.md#install-footprint-metadata) has an optional cached npm registry provider for `dist.unpackedSize`. It is **off by default** (`GHOSTDEPS_FOOTPRINT=true` opts in), queries only exact public npm registry origins derived from lockfile evidence, and does not call Bundlephobia or Packagephobia. Other ecosystems do not get install footprints through that provider. The offline CLI has no provider. The original issue's "compute cost ourselves" recommendation is therefore partly implemented, but footprint coverage depends on opt-in and registry metadata, and no bundle size is offered.

## Recommendation

Keep the current lockfile-only impact counts and explicit install-footprint basis. Do not add Bundlephobia's build or Packagephobia's third-party API to the critical GitHub App path. If a later optional external size source is proposed, assess its API rules, availability and data meaning separately; it must not turn an unknown footprint into a removal verdict.
