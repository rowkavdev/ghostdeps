/**
 * GraphNode.registryOrigin for JS/TS lockfiles (#174 step 3). The origin is
 * the lowercase `scheme://host[:port]` of where a package was fetched from,
 * taken only from explicit evidence: a lockfile's resolved tarball URL, or a
 * scoped registry binding in .npmrc that unambiguously covers the package's
 * scope. Everything here is repository data, so anything unusual (other
 * schemes, credentials, queries, env interpolation, conflicting bindings)
 * yields undefined: absent fails closed, meaning no registry lookup.
 */

/** Longest URL (tarball or registry) considered; real ones are far shorter. */
export const MAX_ORIGIN_URL_LENGTH = 2048;

/** Largest .npmrc read for scoped registry bindings. */
export const MAX_NPMRC_BYTES = 64 * 1024;

/** Any C0 control character or DEL. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Parse a raw http(s) URL strictly. Undefined for other schemes, any
 * userinfo (even an empty `@`), a query (even an empty `?`), whitespace or
 * backslashes (which WHATWG URL parsing would silently repair), and, unless
 * allowed, a fragment.
 */
function strictHttpUrl(raw: unknown, allowFragment: boolean): URL | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ORIGIN_URL_LENGTH) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw) || hasControl(raw)) return undefined;
  if (raw.includes("?")) return undefined;
  if (!allowFragment && raw.includes("#")) return undefined;
  const authorityEnd = raw.slice(raw.indexOf("//") + 2).search(/[/?#]/);
  const authority = raw
    .slice(raw.indexOf("//") + 2)
    .slice(0, authorityEnd < 0 ? undefined : authorityEnd);
  if (authority.length === 0 || authority.includes("@")) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hostname === "") return undefined;
  return url;
}

/**
 * Origin of an npm-registry tarball URL for package `name`, or undefined.
 * The path must have the registry tarball shape `.../<name>/-/<file>.tgz`
 * (a scoped name may have its slash encoded as %2f), so git, codeload and
 * other plain URL tarballs don't count as registry evidence. Yarn classic
 * appends the integrity hash as a fragment, so it may pass allowFragment.
 */
export function tarballOrigin(
  resolved: unknown,
  name: string,
  opts: { allowFragment?: boolean } = {},
): string | undefined {
  const url = strictHttpUrl(resolved, opts.allowFragment === true);
  if (!url || name.length === 0) return undefined;
  const path = url.pathname;
  if (!path.endsWith(".tgz")) return undefined;
  const names = [name];
  if (name.startsWith("@") && name.includes("/")) names.push(name.replace("/", "%2f"));
  const lower = path.toLowerCase();
  const shaped = names.some((n) => {
    const i = n === name ? path.indexOf(`/${n}/-/`) : lower.indexOf(`/${n.toLowerCase()}/-/`);
    return i >= 0 && !path.slice(i + n.length + 4).includes("/");
  });
  return shaped ? url.origin : undefined;
}

/** Origin of a registry URL from a scoped .npmrc binding (any path allowed), or undefined. */
export function registryUrlOrigin(value: string): string | undefined {
  return strictHttpUrl(value, false)?.origin;
}

/**
 * Scoped registry bindings (`@scope:registry=<url>`) in one .npmrc, as
 * scope -> origin, or null when the scope's binding can't be trusted: an
 * unparsable or interpolated value, quotes, or two lines that disagree.
 * Bare `registry=` defaults are ignored: they are not evidence (the user or
 * CI config may override them). Only these lines are read; auth tokens and
 * every other setting are never looked at or kept.
 */
export function scopedRegistries(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(@[^\s=:]+):registry\s*=(.*)$/.exec(line);
    if (!m) continue;
    const scope = m[1]!;
    const value = m[2]!.trim();
    const origin =
      /[$"'`]/.test(value) || !/^@[a-z0-9][a-z0-9._~-]*$/.test(scope)
        ? null
        : (registryUrlOrigin(value) ?? null);
    if (!out.has(scope)) out.set(scope, origin);
    else if (out.get(scope) !== origin) out.set(scope, null);
  }
  return out;
}

/** The trusted scoped-registry origin for `name`, or undefined (unscoped, unbound or ambiguous). */
export function scopedOrigin(
  name: string,
  bindings: ReadonlyMap<string, string | null> | undefined,
): string | undefined {
  if (!bindings || !name.startsWith("@")) return undefined;
  const slash = name.indexOf("/");
  if (slash <= 1) return undefined;
  const origin = bindings.get(name.slice(0, slash));
  return typeof origin === "string" ? origin : undefined;
}

/**
 * Combine the lockfile directory's .npmrc with a workspace member's own
 * .npmrc (when it has one): a scope is trusted only when the root binds it
 * and the member doesn't bind it differently.
 */
export function mergeBindings(
  root: ReadonlyMap<string, string | null>,
  member: ReadonlyMap<string, string | null> | undefined,
): Map<string, string | null> {
  const out = new Map(root);
  if (member) {
    for (const [scope, origin] of member) {
      if (out.has(scope) && out.get(scope) !== origin) out.set(scope, null);
    }
  }
  return out;
}
