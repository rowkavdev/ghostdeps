# Native replacement rules for Rust

Research for [#66](https://github.com/rowkavdev/ghostdeps/issues/66), checked against GhostDeps main on 25 September 2026. These are proposed, version-gated rules, **not current Rust verdicts**: main has a [shared rule interface](https://github.com/rowkavdev/ghostdeps/blob/main/packages/core/src/native-rules/index.ts) but no populated Rust rules or native-removal policy.

## Candidate seeds

| Crate and covered use                                       | Standard-library alternative                                                                               | Minimum stable Rust and caveat                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `once_cell::sync::OnceCell`                                 | [`std::sync::OnceLock`](https://doc.rust-lang.org/std/sync/struct.OnceLock.html)                           | 1.70; `once_cell` extras such as `race` and fallible initialization need separate review.            |
| `lazy_static` simple static values, `once_cell::sync::Lazy` | [`std::sync::LazyLock`](https://doc.rust-lang.org/std/sync/struct.LazyLock.html)                           | 1.80; replacing the macro changes source syntax and may change initialization behavior.              |
| `once_cell::unsync::Lazy`                                   | [`std::cell::LazyCell`](https://doc.rust-lang.org/std/cell/struct.LazyCell.html)                           | 1.80; check the precise items and methods used.                                                      |
| `atty` / `is-terminal`, terminal detection                  | [`std::io::IsTerminal`](https://doc.rust-lang.org/std/io/trait.IsTerminal.html)                            | 1.70; `std` is required.                                                                             |
| `num_cpus::get()` alone                                     | [`std::thread::available_parallelism`](https://doc.rust-lang.org/std/thread/fn.available_parallelism.html) | 1.59; returns `Result`, may reflect affinity or container limits, and is not the physical CPU count. |
| `memoffset` offset computation alone                        | [`core::mem::offset_of!`](https://doc.rust-lang.org/std/mem/macro.offset_of.html)                          | 1.77; check macro semantics and supported fields.                                                    |
| `itertools::repeat_n` alone                                 | [`std::iter::repeat_n`](https://doc.rust-lang.org/std/iter/fn.repeat_n.html)                               | 1.82; the crate is removable only when no other iterator helpers are used.                           |

`async-trait` to native `async fn` in traits (1.75) is **migration guidance only**, not a high-confidence removal rule. Native async trait methods are not `dyn`-compatible and public traits cannot let callers add a `Send` bound to their returned futures. The [Rust language team's announcement](https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits/) explains the restrictions and possible separate trait variants.

## Evidence required

- Read `rust-version` for each workspace member, inherited settings, `rust-toolchain.toml`, and a library's stated downstream MSRV. A newer CI toolchain does not authorize raising library MSRV. With no authoritative floor, do not offer an automatic replacement verdict.
- Resolve renamed crate paths and exact items used. Text matches and macro-generated code may miss uses; an incomplete reference check is not proof of removability. A crate with other APIs still in use remains a dependency.
- Distinguish `no_std` / `core` from `std`, target compatibility, trait-object use, and feature-gated code. Call out semantic or source changes and keep confidence low where a build or public API review is needed.
- For each seed, test one covered use, one below-MSRV fixture, a disqualifying API, and a workspace or feature-gated use. Attach the rule version and source location to any future finding. GhostDeps must continue static analysis without compiling a repository to decide a verdict.

This page does not claim Rust unused-dependency removal. The [current recommendation policy](../recommendation-policy.md) requires complete reference analysis before `unused`; see the [Rust specialist comparison](rust-unused-dependencies.md) for the different tradeoffs of compile-based tools.
