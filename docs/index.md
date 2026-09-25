# GhostDeps

**Does this codebase actually need this dependency?** GhostDeps reads manifests, lockfiles and source code to explain dependency use with evidence and confidence. It uses static analysis: repository code is not executed. When it cannot be sure, it says so instead of giving a false removal recommendation.

GhostDeps is in early development. Features and language coverage are still changing. See the [GitHub App behaviour](github-app.md) and [CLI status](cli.md) before depending on a finding in CI. The GitHub App reports through checks and does not block merges; the CLI can opt into a failure threshold.

- [Self-host the GitHub App](deployment.md)
- [How the analysis works](architecture.md)
- [Security and limits](security-model.md)
- [Development](development.md)
- [Source repository](https://github.com/rowkavdev/ghostdeps)
