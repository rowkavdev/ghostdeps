/**
 * @ghostdeps/javascript-typescript — ecosystem adapter for JavaScript and
 * TypeScript projects (npm, pnpm, Yarn, Bun). ADR 0002 is the contract.
 */
export { createJavaScriptTypeScriptAdapter } from "./adapter.js";
export {
  DETECTION_CONFIDENCE_THRESHOLD,
  JS_ECOSYSTEM,
  detectJavaScriptTypeScript,
} from "./detect.js";
export { detectPackageManagers } from "./package-managers.js";
export type { PackageManagerDetection } from "./package-managers.js";
