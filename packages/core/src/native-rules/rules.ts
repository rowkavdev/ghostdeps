/** Inert seed catalog. No scan, policy or presenter consumes this list. */
import type { NativeRule } from "./index.js";
import { AXIOS_FETCH_RULE } from "./axios-fetch.js";
import { CLONEDEEP_STRUCTUREDCLONE_RULE } from "./clonedeep-structuredclone.js";
import { UUID_RANDOMUUID_RULE } from "./uuid-randomuuid.js";

export const JS_NATIVE_RULES: readonly NativeRule[] = Object.freeze([
  AXIOS_FETCH_RULE,
  UUID_RANDOMUUID_RULE,
  CLONEDEEP_STRUCTUREDCLONE_RULE,
]);
