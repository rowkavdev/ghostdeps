/**
 * Codeload tarball download (ADR 0003, security model rule 2). The API
 * answers GET /tarball/{ref} with a redirect to a short-lived codeload URL;
 * we take the Location header ourselves so the body can be streamed into
 * core's extractTarball under a byte ceiling instead of buffered whole.
 */

/** Only these redirect targets are fetched. */
export const TARBALL_HOSTS: ReadonlySet<string> = new Set(["codeload.github.com"]);

/** Ceiling on compressed bytes read from codeload. extractTarball caps the decompressed side. */
export const DEFAULT_MAX_TARBALL_BYTES = 512 * 1024 * 1024;

export class TarballError extends Error {
  constructor(
    readonly code: "NO_REDIRECT" | "BAD_REDIRECT" | "HTTP" | "TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "TarballError";
  }
}

/** The slice of Octokit needed to ask for the tarball URL. */
export interface TarballClient {
  request(
    route: "GET /repos/{owner}/{repo}/tarball/{ref}",
    params: { owner: string; repo: string; ref: string; request: { redirect: "manual" } },
  ): Promise<{ status: number; headers: { location?: string } }>;
}

export async function tarballUrl(
  client: TarballClient,
  target: { owner: string; repo: string; sha: string },
): Promise<URL> {
  const res = await client.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner: target.owner,
    repo: target.repo,
    ref: target.sha,
    request: { redirect: "manual" },
  });
  const location = res.headers.location;
  if (!location) throw new TarballError("NO_REDIRECT", `tarball request returned ${res.status}`);
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new TarballError("BAD_REDIRECT", "tarball redirect is not a URL");
  }
  if (url.protocol !== "https:" || !TARBALL_HOSTS.has(url.hostname)) {
    throw new TarballError("BAD_REDIRECT", `unexpected tarball host ${url.hostname}`);
  }
  return url;
}

/** Streams the tarball body, failing once more than maxBytes arrive. */
export async function* downloadTarball(
  url: URL,
  options: { maxBytes?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): AsyncIterable<Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(url, {
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok || !res.body)
    throw new TarballError("HTTP", `tarball download returned ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new TarballError("TOO_LARGE", `tarball exceeds ${maxBytes} bytes`);
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new TarballError("TOO_LARGE", `tarball exceeds ${maxBytes} bytes`);
    yield chunk;
  }
}
