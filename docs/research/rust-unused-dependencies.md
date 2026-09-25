# Rust unused dependencies: cargo-machete and cargo-udeps

Research for [#13](https://github.com/rowkavdev/ghostdeps/issues/13). Checked against GhostDeps main on 25 September 2026.

## Problem

A crate in `Cargo.toml` can be unused, but source-only scans may miss generated code, macro expansion, doctests and target- or feature-gated use. Compilation can answer a narrower configured build question, but requires executing or building untrusted repository code, which GhostDeps does not do.

## Existing solutions

- [cargo-machete](https://github.com/bnjbvr/cargo-machete) searches source text for crate names without compiling. It supports ignored dependencies, renamed import names and JSON output. Its `--with-metadata` option calls `cargo metadata --all-features` and may modify a project's `Cargo.lock`; GhostDeps should not invoke it on an untrusted checkout.
- [cargo-udeps](https://github.com/est31/cargo-udeps) uses a Cargo/nightly compiler run to detect unused declarations. Its README says it cannot check dependencies used only by doctests and documents cases that may go undetected. It is a useful comparison tool on a trusted fixture, not a scanner to run inside GhostDeps.

## Useful techniques and limits

- Resolve renamed dependency keys to their crate import names. A package's registry name is not always the identifier seen in source.
- Track normal, dev, build, optional and target-specific declarations separately. Generated code or a proc macro can make a source-only absence inconclusive.
- Read tool-specific ignore metadata only as migration context, not as proof a package is used. Imports through macros and generated files need explicit limitations rather than an aggressive removal verdict.

## Fit with GhostDeps today

The [Rust adapter](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/rust/src/adapter.ts) already parses Cargo manifests/workspaces, builds a Cargo.lock graph and scans `.rs` references with [WASM tree-sitter](https://github.com/rowkavdev/ghostdeps/blob/main/packages/adapters/rust/src/usage.ts). It recognises `use` trees, `extern crate`, qualified paths and macro paths, and maps manifest renames to crate identifiers. The scan reads source as text; it does not compile or expand macros. Syntax errors are noted, but the adapter deliberately does **not** declare `referenceAnalysis`; no absent Rust reference becomes an `unused` removal verdict under [core policy](../recommendation-policy.md).

The current manifest parser records feature and target conditions for dependencies; that is not unused-feature analysis. Neither tool's output is integrated as a GhostDeps verdict. We have not established a complete inventory of other Rust feature-analysis tools, so an unused-feature niche should remain a hypothesis, not a claim that no tool addresses it.

## Recommendation

Keep the current static parser and its no-unused-verdict gate. Use cargo-machete and cargo-udeps as comparison baselines on owned fixtures, especially renamed crates, workspace inheritance, generated code, macros and target/feature gates. A later feature-analysis proposal needs separate design and tests; do not relax `referenceAnalysis` until the corpus validates absence claims across these cases.
