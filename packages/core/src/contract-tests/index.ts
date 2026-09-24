/**
 * Shared adapter contract tests. Every adapter runs this suite against its
 * own fixtures; an adapter that cannot pass does not merge (ADR 0002).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, EcosystemAdapter } from "../adapter.js";

/** Invariants every adapter must honour, whatever the ecosystem. */
export function runAdapterContractTests(adapter: EcosystemAdapter, context: AdapterContext): void {
  describe(`adapter contract: ${adapter.ecosystem}`, () => {
    it("declares a supported API version", () => {
      assert.match(adapter.apiVersion, /^\d+\.\d+\.\d+$/);
    });

    it("detection returns confidence within [0,1] with evidence", async () => {
      const result = await adapter.detect(context);
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
      assert.ok(Array.isArray(result.evidence));
      if (result.confidence > 0) {
        assert.ok(result.evidence.length > 0, "positive detection needs evidence");
      }
    });

    it("dependencies carry kind, constraint and origin", async () => {
      const detection = await adapter.detect(context);
      const deps = await adapter.listDirectDependencies(context, detection.projects);
      for (const dep of deps) {
        assert.ok(dep.name.length > 0);
        assert.ok(dep.constraint.length > 0);
        assert.ok(dep.declaredIn.length > 0);
        assert.ok(["runtime", "dev", "peer", "optional", "build"].includes(dep.kind));
      }
    });

    it("usage findings always carry file and line evidence", async () => {
      if (!adapter.findUsage) return;
      const detection = await adapter.detect(context);
      const deps = await adapter.listDirectDependencies(context, detection.projects);
      for (const dep of deps.slice(0, 5)) {
        for (const usage of await adapter.findUsage(context, dep)) {
          assert.ok(usage.file.length > 0, "usage without a file is not evidence");
          assert.ok(usage.line > 0, "usage without a line is not evidence");
        }
      }
    });

    it("optional capabilities match the declared set", () => {
      assert.equal(
        Boolean(adapter.buildDependencyGraph),
        adapter.capabilities.has("dependencyGraph"),
      );
      assert.equal(Boolean(adapter.findUsage), adapter.capabilities.has("usageAnalysis"));
      assert.equal(
        Boolean(adapter.findNativeAlternatives),
        adapter.capabilities.has("nativeAlternatives"),
      );
      assert.equal(Boolean(adapter.analyseHealth), adapter.capabilities.has("health"));
    });
  });
}
