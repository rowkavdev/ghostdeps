# GhostDeps

**GhostDeps — find dependencies your code doesn't really need, in any language.**

GhostDeps is universal dependency intelligence for software repositories. It answers a question existing dependency tools don't answer well:

> **Does this codebase actually need this dependency?**

For each direct dependency, GhostDeps aims to determine whether it is used, where, which parts of it are used, whether the runtime now provides a native alternative, whether another dependency already covers the same capability, what it costs you in transitive packages and install size, how healthy it is, and what replacing it would take — with evidence and a confidence level attached to every claim.

GhostDeps is conservative by design. A false positive that tells you to remove something necessary is far worse than no recommendation, so it says "manual review recommended" whenever it can't be sure.

## Status

Early development. The architecture is being laid down right now — see the [project board](https://github.com/orgs/rowkavdev/projects) and [docs/](docs/) for what's agreed and what's in flight.

Ecosystem support lands incrementally and is never advertised before it works:

- **First production-quality targets:** JavaScript/TypeScript (npm, pnpm, Yarn, Bun), Python (pip, Poetry, uv, Pipenv), Rust (Cargo), Go (Go Modules)
- **Later:** Maven, Gradle, NuGet, Composer, Bundler, SwiftPM, Dart/pub, Conan, vcpkg and others

## Interfaces

- **GitHub App (primary):** reacts to pull requests and pushes, analyses dependency changes in context, and reports through GitHub Checks with annotations. No noisy bot comments.
- **CLI (secondary):** `ghostdeps scan`, `ghostdeps inspect <pkg>`, `ghostdeps explain <pkg>`, JSON output — the same analysis engine, no separate implementation.

## Principles

- **Deterministic first.** No LLM or API key is required. Deterministic evidence is the foundation; any future AI assistance is optional and additive.
- **Static analysis only.** GhostDeps never executes repository code. Manifests, lockfiles and source files are treated as untrusted input. See [docs/security-model.md](docs/security-model.md).
- **Evidence or silence.** Every recommendation carries evidence and a confidence level. See [docs/architecture.md](docs/architecture.md).
- **Multi-language from day one.** Ecosystem adapters plug into a shared core; nothing is bolted on.

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Architecture Decision Records](docs/adr/)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
