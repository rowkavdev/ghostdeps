# Contributing an ecosystem adapter

1. **Open or claim an adapter issue first.** Adapter requests use the
   "Ecosystem adapter request" issue template. Detection, parsing, usage
   analysis and fixtures are separate issues - claim them individually.
2. **Create the package** at `packages/adapters/<ecosystem>` implementing
   `EcosystemAdapter` from `@ghostdeps/core`. Copy no policy into your
   adapter: it reports facts with evidence; core recommends.
3. **Add fixtures** under `fixtures/<ecosystem>/` with `expected.json`
   metadata (see fixtures/README.md). Cover the boring case and at least
   one edge case from the start (import-name mismatch, workspace,
   malformed manifest).
4. **Run the contract tests.** `runAdapterContractTests(adapter, context)`
   from `@ghostdeps/core` must pass against your fixtures, plus your own
   unit tests for parsing and detection.
5. **Mind the false-positive budget.** GhostDeps is conservative: when
   analysis is incomplete (dynamic imports, generated code, executable
   manifests), report reduced confidence and limitations instead of a
   verdict.
6. **Update docs/adapters.md** status table in the same PR.

Breaking the adapter contract requires an ADR and a major bump of
`adapterApiVersion`; drive-by PRs must not change it.
