# polyglot/js-app-python-service

A JS app at the repository root (axios, npm lockfile) with a Python service
nested at `services/api` (requests, uv lockfile).

It exercises the #55 repository-wide model: one project tree across
ecosystems (the service's parent is the root JS project), one unified graph
with a completeness entry per ecosystem, and a cross-ecosystem capability
overlap note on each HTTP client.

Both sides run through the shipped adapters (`defaultAdapters()`): the real
JS adapter and the real Python adapter (`@ghostdeps/python`). The test-only
stub Python adapter that stood in before the real one landed is gone.
