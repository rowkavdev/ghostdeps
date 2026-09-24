# Repository scanner

The scanner is pipeline step 1 (repository discovery, see [architecture.md](architecture.md)). It walks a local directory, usually an extracted codeload tarball (the extraction helper is #8), and produces:

- the file list served by `FsRepositoryHandle`, the filesystem `RepositoryHandle` adapters read through
- candidate project roots: directories holding a recognised manifest, with the ecosystem each manifest hints at
- a skipped-entries list saying what was not listed and why
- a `truncated` marker when a walk ceiling stopped the scan early

Code: `packages/core/src/engine/scanner/`.

## Usage

```ts
import { FsRepositoryHandle } from "@ghostdeps/core";

const repo = await FsRepositoryHandle.open("/tmp/checkout");
repo.scan.candidateProjectRoots; // [{ path: "packages/web", manifests: ["package.json"], ecosystemHints: ["javascript-typescript"] }, ...]
repo.scan.truncated; // undefined, or "max-files" | "max-directories" | "max-total-bytes"
await repo.readFile("packages/web/package.json");
```

Candidate roots are hints. Adapters make the evidence-based detection decision (ADR 0002); the scanner never parses a manifest.

## Security rules

Everything in the scanned directory is attacker-controlled ([security-model.md](security-model.md)).

- **Symlinks are never followed**, whether they point inside or outside the root. They are recorded as skipped. A symlinked scan root is refused.
- **Only regular files and real directories.** FIFOs, sockets and devices are skipped (`special-file`).
- **Unambiguous names only.** Names that are not valid UTF-8, or contain control characters or backslashes, are skipped (`unsafe-name`). Every listed path is a POSIX path relative to the root.
- **Reads are re-checked.** The directory can change between scan and read. `readFile` serves only listed paths, checks that every parent component is still a real directory, opens with `O_NOFOLLOW`, re-checks the size and reads at most the ceiling plus one byte. Files with a NUL byte in the first 8 KiB are refused as binary. Failures throw `RepositoryReadError` with a code: `not-listed`, `changed`, `too-large` or `binary`.
- **Bounded walk.** Iterative (no recursion), with the ceilings below. Hitting a walk ceiling marks the result truncated instead of failing, so analysis can report reduced confidence.
- **Nothing is executed or parsed.**

## Limits

Defaults (`DEFAULT_SCAN_LIMITS`), overridable per scan:

| Limit              | Default | Effect when exceeded                       |
| ------------------ | ------- | ------------------------------------------ |
| `maxFiles`         | 50,000  | scan stops, `truncated: "max-files"`       |
| `maxDirectories`   | 20,000  | scan stops, `truncated: "max-directories"` |
| `maxTotalBytes`    | 512 MiB | scan stops, `truncated: "max-total-bytes"` |
| `maxDepth`         | 32      | deeper directory skipped (`too-deep`)      |
| `maxPathLength`    | 1,024   | entry skipped (`path-too-long`)            |
| `maxFileBytes`     | 2 MiB   | file skipped (`file-too-large`)            |
| `maxLockfileBytes` | 32 MiB  | lockfile skipped (`file-too-large`)        |

Lockfiles get their own, larger ceiling because graph parsing depends on them and they are legitimately big in monorepos.

## Default exclusions

Excluded directories are recorded once, at the directory, and never walked. The list lives in `exclusions.ts`; callers can replace it.

- VCS: `.git`, `.hg`, `.svn`
- JavaScript/TypeScript: `node_modules`, `bower_components`, `jspm_packages`, `.pnpm-store`, `.yarn`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`
- Python: `__pycache__`, `.venv`, `venv`, `.tox`, `.nox`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `site-packages`
- Rust/JVM: `target`, `.gradle`
- Vendored code: `vendor`, `third_party`, `Pods`

Generated files skipped by suffix: `.min.js`, `.min.mjs`, `.min.cjs`, `.min.css`, `.map`. Lockfiles are never excluded as generated.

Exclusion is about focus, not safety; the ceilings are the safety control.
