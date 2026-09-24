import { describe } from "node:test";
import { runAdapterContractTests } from "@ghostdeps/core";
import { createRustAdapter } from "./adapter.js";
import { fixtureHandle } from "./testing/fs-handle.js";

describe("rust adapter contract", () => {
  for (const fixture of [
    "single-crate",
    "workspace",
    "feature-conditional",
    "malformed-manifest",
  ]) {
    runAdapterContractTests(createRustAdapter(), {
      repository: fixtureHandle("rust", fixture),
      network: { mode: "offline" },
    });
  }
});
