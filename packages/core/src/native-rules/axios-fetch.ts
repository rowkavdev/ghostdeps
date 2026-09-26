import type { NativeRule } from "./index.js";

/** This is a review candidate, never a source rewrite or an automatic removal. */
export const AXIOS_FETCH_RULE: NativeRule = Object.freeze({
  id: "javascript-typescript/axios-to-fetch/v1",
  ecosystem: "javascript-typescript",
  packages: ["axios"],
  nativeCapability: "fetch()",
  minimumRuntime: { node: "21.0.0" },
  coveredApis: ["get"],
  incompatibleUses: [
    "interceptors",
    "create",
    "defaults",
    "adapter",
    "CancelToken",
    "signal",
    "transformRequest",
    "transformResponse",
    "onUploadProgress",
    "onDownloadProgress",
    "responseType",
    "validateStatus",
    "timeout",
    "error.response",
    "error.code",
  ],
  semanticDifferences: [
    "fetch resolves HTTP error statuses unless response.ok is checked",
    "fetch returns a Response, not Axios's parsed response.data",
    "fetch cancellation, redirect, timeout and credentials behavior differ",
  ],
  confidenceCriteria: [
    "all deployment targets run stable Node fetch (21.0.0 or later)",
    "all call sites and options are resolved",
    "status handling and response parsing differences are checked at every use",
  ],
  references: [
    "https://nodejs.org/api/globals.html",
    "https://axios-http.com/docs/handling_errors",
    "https://axios-http.com/docs/req_config",
    "https://axios-http.com/docs/interceptors",
  ],
});
