# polyglot/js-app-python-service

A JS app at the repository root (axios, npm lockfile) with a Python service
nested at `services/api` (requests).

It exercises the #55 repository-wide model: one project tree across
ecosystems (the service's parent is the root JS project), one unified graph
with a completeness entry per ecosystem, and a cross-ecosystem capability
overlap note on each HTTP client.

There is no Python adapter yet. The test pairs the real JS adapter with a
test-only stub (`packages/cli/src/testing/stub-python-adapter.ts`) that reads
`pyproject.toml` and the plain `requirements.lock` here. This fixture proves
the multi-ecosystem mechanics only; the real Python adapter is checked
against the same expectations when it lands.
