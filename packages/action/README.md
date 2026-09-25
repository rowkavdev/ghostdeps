# @ghostdeps/action

GitHub Action distribution of GhostDeps: the same analysis engine and the same
check-run rendering as the GitHub App, running inside your own Actions runner.
Built for teams that want dependency analysis without installing an external
service. The engine is wrapped, not forked (ADR-0003): this package builds
`@ghostdeps/cli`, runs `scan --json`, and posts the result through
`@ghostdeps/checks-renderer`, the exact mapping the app uses.

See [docs/github-action.md](../../docs/github-action.md) for usage, required
permissions, and the known feature losses versus the GitHub App.
