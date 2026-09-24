# fixtures/go

Go module scenarios for the Go adapter (#52, #53, #54). See fixtures/README.md
for conventions. Nothing here is built or run; go.sum hashes are placeholders.

| Fixture           | Scenario                                                                           |
| ----------------- | ---------------------------------------------------------------------------------- |
| `single-module`   | one module; direct vs `// indirect`; one required-but-unimported module              |
| `multi-module`    | `go.work` with two modules; local `replace`; one module path, several packages      |
| `vendored`        | `vendor/modules.txt`; imports inside `vendor/` never count as project usage         |
| `replace-exclude` | module and local-directory `replace`; `exclude`; nested module directory           |
| `import-forms`    | blank/dot imports, `_test.go`-only use, `tool` directive, comments/raw strings, longest module path wins |
| `malformed-gomod` | bad require lines surface as incompleteness; no `unused` verdicts                   |

Go-specific blocks in `expected.json`, consumed by the Go adapter's own suite:

- `graph`: module names expected as graph nodes, which of them are `// indirect`,
  and whether the graph is marked incomplete (edges need `go mod graph`, which is
  never run).
- `usages`: per module, the expected import sites (`file`, `line`, `symbols`,
  optional `via`). An empty list means the module must have no usages.
