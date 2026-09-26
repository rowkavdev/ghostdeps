import type { NativeRule } from "./index.js";

/** UUID v4 string generation only. No parsing, validation or other UUID versions. */
export const UUID_RANDOMUUID_RULE: NativeRule = Object.freeze({
  id: "javascript-typescript/uuid-v4-to-randomuuid/v1",
  ecosystem: "javascript-typescript",
  packages: ["uuid"],
  nativeCapability: "node:crypto.randomUUID()",
  // Choose the conservative LTS-compatible floor rather than the older 15.6 branch.
  minimumRuntime: { node: "14.17.0" },
  coveredApis: ["v4"],
  incompatibleUses: [
    "v1",
    "v3",
    "v5",
    "v6",
    "v7",
    "parse",
    "stringify",
    "validate",
    "version",
    "NIL",
    "MAX",
    "v4 options",
    "v4 buffer",
    "browser crypto",
    "custom RNG",
  ],
  semanticDifferences: [
    "node:crypto.randomUUID() returns a v4 string, not a buffer or caller-supplied bytes",
    "Node crypto availability and browser secure-context requirements are separate deployment targets",
  ],
  confidenceCriteria: [
    "all deployment targets support node:crypto.randomUUID() at Node 14.17.0 or later",
    "every import and call is proven to be v4() with no options or output buffer",
    "browser, custom RNG, other UUID versions and utility APIs are ruled out",
  ],
  references: [
    "https://nodejs.org/api/crypto.html#cryptorandomuuidoptions",
    "https://github.com/uuidjs/uuid#readme",
  ],
});
