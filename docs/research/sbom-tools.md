# SBOM tools and package identity

Research for [#17](https://github.com/rowkavdev/ghostdeps/issues/17). Checked against GhostDeps main on 25 September 2026.

## Problem

A software bill of materials (SBOM) inventories components in source trees, builds or images. GhostDeps instead asks whether a declared dependency is used and what evidence supports a recommendation. An inventory alone cannot prove absence of use.

## Existing solutions

- [Syft](https://github.com/anchore/syft) scans images, filesystems and archives across many package ecosystems; it can emit CycloneDX, SPDX and Syft JSON. It can inventory installed artifacts as well as manifests.
- [cdxgen](https://github.com/CycloneDX/cdxgen) generates CycloneDX JSON BOMs from source and other targets, with validation and SPDX 3 JSON-LD export options. Its broader audit and introspection modes are separate from GhostDeps' read-only dependency-use analysis.
- The [CycloneDX tool center](https://cyclonedx.org/tool-center/) lists further generators, validators and consumers. These ecosystems already have dedicated SBOM generation tools; GhostDeps need not reinvent one for a dependency-use check.

## Techniques and limits

[Package URL (purl)](https://github.com/package-url/purl-spec) is a portable component identifier with ecosystem type, name, version and optional qualifiers. It is useful when linking inventories or external metadata. It is not by itself proof of a dependency's role or a complete match across local, git, alias, workspace and registry declarations. SBOM contents can depend on what source, lockfile, build or image the generator scanned; record the source and completeness before comparing inventories.

## Fit with GhostDeps today

GhostDeps' [dependency model](https://github.com/rowkavdev/ghostdeps/blob/main/packages/core/src/types/index.ts) identifies declarations by ecosystem/project, name, constraint, kind and manifest, with a separate lockfile graph. It does **not** use purl as the internal key, ingest CycloneDX/SPDX as an input, or export an SBOM. Its [analysis](../architecture.md) is static, and the primary UI is a GitHub Check with evidence and confidence. Replacing the existing key with purl or accepting an SBOM would be a separate compatibility, provenance and security design, not a documentation-only step.

## Recommendation

Keep GhostDeps focused on usage evidence. If interoperability becomes needed, add an optional purl mapping for registry-resolved nodes and test ambiguous or local sources instead of changing internal identity blindly. Treat SBOM input/export as a later scoped proposal with source provenance and resource limits. For users who need a BOM now, point to Syft or cdxgen rather than suggesting a GhostDeps removal finding is an inventory.
