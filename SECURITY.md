# Security Policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting for this repository (**Security → Advisories → Report a vulnerability**). Do not open a public issue.

We aim to acknowledge reports within 72 hours.

## Scope notes

GhostDeps analyses untrusted third-party repositories by design. Its threat model — including the rule that repository code is never executed and all repository content is treated as hostile input — is documented in [docs/security-model.md](docs/security-model.md). If you find a way to make GhostDeps execute, exfiltrate, or trust attacker-controlled content beyond that model, that is a vulnerability and we want to hear about it.

## Supported versions

GhostDeps is pre-1.0. The latest commit on `main` and the latest tagged release are the only supported versions.
