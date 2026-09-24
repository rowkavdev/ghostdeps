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
