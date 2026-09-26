import type { NativeRule } from "./index.js";

/** Review candidate for plain serializable data only; never a generic deep-clone swap. */
export const CLONEDEEP_STRUCTUREDCLONE_RULE: NativeRule = Object.freeze({
  id: "javascript-typescript/lodash-clonedeep-to-structuredclone/v1",
  ecosystem: "javascript-typescript",
  packages: ["lodash.clonedeep"],
  nativeCapability: "structuredClone()",
  minimumRuntime: { node: "17.0.0" },
  coveredApis: ["cloneDeep"],
  incompatibleUses: [
    "functions",
    "symbols",
    "DOM nodes",
    "custom instances",
    "prototype reliance",
    "property descriptors",
    "getters",
    "setters",
    "RegExp.lastIndex",
    "non-cloneable values",
    "customizer",
    "cloneDeepWith",
    "transfer options",
    "browser target",
  ],
  semanticDifferences: [
    "structuredClone throws DataCloneError for functions and other non-cloneable values",
    "structuredClone does not preserve arbitrary prototypes, property descriptors or accessors",
    "structuredClone does not preserve RegExp.lastIndex; transfer behavior needs a separate review",
  ],
  confidenceCriteria: [
    "all deployment targets provide structuredClone() at Node 17.0.0 or later",
    "every input is proven to be plain structured-cloneable data",
    "no caller relies on prototype identity, descriptors, accessors or unsupported values",
  ],
  references: [
    "https://nodejs.org/api/globals.html#structuredclonevalue-options",
    "https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm",
    "https://lodash.com/docs/4.17.15#cloneDeep",
  ],
});
