/**
 * Registry origins (#174 step 3). The one place that says which lockfile
 * origins count as the public npm registry: js's origin derivation and the
 * GitHub App's footprint provider both read it from here, never a copy.
 */

/**
 * Origins that serve the public npm package set (lead ruling on #174):
 * npm's registry and yarn classic's mirror of it. An exact two-entry
 * allowlist, compared as whole canonical origins - never a suffix, subdomain
 * or wildcard match. Any other origin proves nothing and fails closed.
 */
export const PUBLIC_NPM_REGISTRY_ORIGINS: readonly string[] = Object.freeze([
  "https://registry.npmjs.org",
  "https://registry.yarnpkg.com",
]);

/**
 * GraphNode.registryOrigin as a canonical origin, or undefined. It comes
 * from repository data, so only a plain http(s) origin passes: no path,
 * credentials, query or fragment.
 */
export function normaliseRegistryOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  if (value.replace(/\/$/, "").toLowerCase() !== url.origin) return undefined;
  return url.origin;
}

/**
 * True only when `origin` is exactly one of PUBLIC_NPM_REGISTRY_ORIGINS
 * after canonicalisation (lowercase, one optional trailing slash). No
 * suffix or subdomain matching: `https://registry.npmjs.org.evil.example`
 * and `https://mirror.registry.npmjs.org` are not public.
 */
export function isPublicNpmRegistryOrigin(origin: unknown): boolean {
  const canonical = normaliseRegistryOrigin(origin);
  return canonical !== undefined && PUBLIC_NPM_REGISTRY_ORIGINS.includes(canonical);
}
