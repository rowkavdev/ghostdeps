# Go module tooling

Research for [#15](https://github.com/rowkavdev/ghostdeps/issues/15). Checked against GhostDeps main on 25 September 2026.

## Problem

`go.mod` requirements, Go package imports and module graph edges answer different questions. A required module can be indirect, a package may be selected only under certain build tags, and the graph cannot be inferred reliably from `go.mod` alone.

## Existing solutions

- [`go mod tidy`](https://go.dev/ref/mod#go-mod-tidy) adds missing and removes unused module requirements. It loads packages and their tests/tools recursively, considers nearly all build tags, and can download modules. `-diff` prints intended `go.mod`/`go.sum` edits without writing them, but still invokes the Go toolchain and resolution machinery.
- [`go mod why -m`](https://go.dev/ref/mod#go-mod-why) explains a module through a shortest import path. [`go mod graph`](https://go.dev/ref/mod#go-mod-graph) prints module requirement edges. These are useful baselines and evidence shapes, but invoking them in the GhostDeps GitHub App would cross its static-read boundary and may contact a module proxy.
- [gomod](https://github.com/helcaraxan/gomod), [modwhy](https://github.com/corani/modwhy) and [gomoddepgraph](https://github.com/rhansen/gomoddepgraph) provide querying or visualisation over Go dependency relationships. They do not make a parsed list of requirements into a verified full module graph.

## Useful techniques and limits

Distinguish an import path from its owning module, prefer the longest required-module prefix, and retain the path from source import to declaration as evidence. `// indirect` describes a requirement's role, not whether the module is unnecessary. Go tool outputs may be compared on an owned fixture, but `tidy -diff` is not a safe or complete substitute for static reads in the App: it may resolve/download modules even when no file is written.

## Fit with GhostDeps today

The [Go adapter](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/go/src/adapter.ts) statically reads `go.mod` and source imports; its [usage scanner](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/go/src/usage/scan.ts) attributes imports by longest module prefix and credits `tool` directives. The [module graph](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/go/src/manifest.ts) has requirement and optional vendored nodes but **no edges**; it is always marked incomplete. GhostDeps does not run `go mod tidy`, `why` or `graph`, and its source import extractor is a lexer, not `go/parser` or full build-tag evaluation. The adapter does not claim `referenceAnalysis`, so absent Go imports never become an `unused` removal verdict under [core policy](../recommendation-policy.md).

## Recommendation

Keep the static usage evidence and explicitly incomplete graph. Compare import attribution with `go mod why` and tidy on owned, network-controlled fixtures, especially replacements, nested modules, build tags and tools. Do not add a `tidy -diff` runtime cross-check to the App without a separate security decision; do not report a full why-chain or high-confidence unused verdict from today's edgeless static graph.
