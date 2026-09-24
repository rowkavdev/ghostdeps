/**
 * This GitHub App's id from the APP_ID environment variable that `probot run`
 * also reads. Returns undefined unless it is a positive integer, so callers
 * never compare check runs against NaN.
 */
export function appIdFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.APP_ID?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * GHOSTDEPS_SOURCE_PR_TRIGGER: the source-only PR trigger (#101) is on
 * unless this is "false" or "0".
 */
export function sourcePrTriggerFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GHOSTDEPS_SOURCE_PR_TRIGGER?.trim().toLowerCase();
  return !(raw === "false" || raw === "0");
}

/**
 * GHOSTDEPS_RECOMMENDATIONS: recommendation verdicts are on unless this is
 * "false" or "0" (then the app reports facts only).
 */
export function recommendationsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GHOSTDEPS_RECOMMENDATIONS?.trim().toLowerCase();
  return !(raw === "false" || raw === "0");
}
