# Native replacement rules for Go

Research for [#67](https://github.com/rowkavdev/ghostdeps/issues/67), checked against GhostDeps main on 25 September 2026. These are rule candidates, not current verdicts. Main defines a [native-rule interface](https://github.com/rowkavdev/ghostdeps/blob/main/packages/core/src/native-rules/index.ts), but does not yet ship a Go native-rule dataset or native-removal policy.

## Candidate seeds

| Dependency and covered use                            | Standard library                                                                               | Floor and mismatch to test                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `golang.org/x/exp/slices`, matching operations        | [`slices`](https://pkg.go.dev/slices)                                                          | Go 1.21+; compare the pinned experimental package's function signatures, especially `SortFunc`.                                           |
| `golang.org/x/exp/maps`, matching operations          | [`maps`](https://pkg.go.dev/maps)                                                              | Go 1.21+ for core operations; `Keys`/`Values` in Go 1.23+ return iterators rather than the older x/exp slices, needing call-site changes. |
| `golang.org/x/exp/constraints.Ordered` alone          | [`cmp.Ordered`](https://pkg.go.dev/cmp#Ordered)                                                | Go 1.21+; `Integer`, `Signed`, `Unsigned` and `Float` have no direct `cmp` counterpart.                                                   |
| `golang.org/x/exp/slog`, supported logging calls      | [`log/slog`](https://pkg.go.dev/log/slog)                                                      | Go 1.21+; inspect handler interfaces and pinned x/exp version before suggesting a swap.                                                   |
| `github.com/pkg/errors`, only wrapping and inspection | [`errors`](https://pkg.go.dev/errors), [`fmt.Errorf` with `%w`](https://pkg.go.dev/fmt#Errorf) | Go 1.13+; stack traces, `WithStack`, `Cause` and `%+v` output are not equivalent.                                                         |
| `go.uber.org/multierr`, only simple combining         | [`errors.Join`](https://pkg.go.dev/errors#Join)                                                | Go 1.20+; output formatting and unwrapping differ; custom formatters disqualify.                                                          |
| `go.uber.org/atomic`, matched typed primitives        | [`sync/atomic`](https://pkg.go.dev/sync/atomic)                                                | Go 1.19+; confirm the exact types and method semantics.                                                                                   |
| `gorilla/mux`, basic method/path routing only         | [`net/http.ServeMux`](https://pkg.go.dev/net/http#ServeMux)                                    | Go 1.22+; host rules, regex constraints, middleware, route names and precedence are not drop-in.                                          |
| `golang.org/x/exp/rand`, limited random APIs          | [`math/rand/v2`](https://pkg.go.dev/math/rand/v2)                                              | Go 1.22+; signatures, sources, seed behavior and statistical expectations differ.                                                         |
| `tools.go` blank-import tooling convention            | [`tool` directive](https://go.dev/doc/go1.24)                                                  | Go 1.24+; changes go.mod/tool invocation and is not an ordinary import removal.                                                           |

The [Go 1.21](https://go.dev/doc/go1.21), [1.22](https://go.dev/doc/go1.22), [1.23](https://go.dev/doc/go1.23) and [1.24](https://go.dev/doc/go1.24) release notes are the version basis above. Go 1.27's new [`uuid`](https://pkg.go.dev/uuid) may eventually be a narrow candidate, but v1/v3/v5/v6 use, serialization and API shape make a general `google/uuid` or `gofrs/uuid` removal claim premature; inspect the exact pinned package and target before designing that rule.

## Evidence required

- Determine the project's supported Go floor from `go.mod`'s `go` directive, release policy and deployment constraints. The `toolchain` line or CI version alone is not a safe floor. Compare the pinned dependency version, since x/exp API signatures changed.
- Resolve imported package paths and used identifiers (including aliases, generated files and build tags) at the right module root. String matches or package names alone do not establish covered uses; absent or incomplete usage never proves removal.
- Gate each candidate on exact API shape and behavior, not just the existence of a std package. Check for a still-needed transitive module before claiming size or install gains. A router or logging migration may require manual design review even if simple calls match.
- Add fixtures for covered uses, below-floor Go versions, x/exp/maps iterator conversion, `pkg/errors` stack formatting and `gorilla/mux` regex routing. Record rule source/version, evidence and disqualifiers. Static inspection must not execute the target repository.

These rules do not imply a Go `unused` removal verdict. The [recommendation policy](../recommendation-policy.md) needs complete reference coverage first; compare [Go module tooling](go-module-tools.md) for existing graph and usage approaches.
