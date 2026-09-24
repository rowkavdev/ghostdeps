/**
 * @ghostdeps/github-app — the GitHub App delivery layer (ADR 0003).
 * Default export is the Probot app function used by `probot run`.
 */
import { createGhostDepsApp } from "./app.js";

export { createGhostDepsApp, HEALTH_PATH } from "./app.js";
export type { GhostDepsAppOptions } from "./app.js";
export * from "./jobs.js";

export default createGhostDepsApp();
