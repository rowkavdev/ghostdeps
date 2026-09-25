import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./post-check.js";
import type { AnalysisResult, Finding } from "@ghostdeps/core";

const cleanResult: AnalysisResult = {
  schemaVersion: 1,
  projects: [],
  dependencies: [],
  usages: [],
  findings: [],
  detected: [],
  surface: [],
};

const unusedFinding: Finding = {
  kind: "unused",
  dependency: "left-pad",
  summary: "left-pad is declared but never imported",
  recommendation: "Remove left-pad from dependencies",
  evidence: [
    { kind: "declared", statement: "declared in package.json", file: "package.json", line: 12 },
  ],
  confidence: "high",
  limitations: [],
  affectedFiles: ["package.json"],
};

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

let dir: string;
let calls: Call[];
let originalEnv: NodeJS.ProcessEnv;
let originalFetch: typeof fetch;

function setEnv(over: Record<string, string | undefined>): void {
  const base: Record<string, string> = {
    GHOSTDEPS_GITHUB_TOKEN: "ghs_test",
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_EVENT_NAME: "push",
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function writeEvent(payload: unknown): Promise<string> {
  const p = join(dir, "event.json");
  await writeFile(p, JSON.stringify(payload));
  return p;
}

async function writeResult(payload: unknown): Promise<string> {
  const p = join(dir, "result.json");
  await writeFile(p, typeof payload === "string" ? payload : JSON.stringify(payload));
  return p;
}

function mockFetch(handler: (c: Call) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(url),
      ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
    };
    calls.push(call);
    const r = handler(call);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ghostdeps-action-"));
  calls = [];
  originalEnv = { ...process.env };
  originalFetch = globalThis.fetch;
  setEnv({});
});

afterEach(async () => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("main", () => {
  it("creates one completed check run on push, no annotations", async () => {
    mockFetch(() => ({ status: 201, body: { id: 1 } }));
    const code = await main(await writeResult(cleanResult));
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url, /\/repos\/acme\/demo\/check-runs$/);
    const body = calls[0]?.body as {
      head_sha: string;
      conclusion: string;
      status: string;
      output: { annotations: unknown[] };
    };
    assert.equal(body.head_sha, "a".repeat(40));
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "success");
    assert.equal(body.output.annotations.length, 0);
  });

  it("on a PR, fetches added lines and checks the PR head SHA", async () => {
    const eventPath = await writeEvent({
      pull_request: { number: 7, head: { sha: "b".repeat(40), repo: { fork: false } } },
    });
    setEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath });
    mockFetch((c) =>
      c.url.includes("/pulls/7/files")
        ? {
            status: 200,
            body: [{ filename: "package.json", patch: "@@ -10,4 +10,5 @@\n a\n-b\n+B\n+C\n d" }],
          }
        : { status: 201, body: { id: 1 } },
    );
    const code = await main(await writeResult({ ...cleanResult, findings: [unusedFinding] }));
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /\/pulls\/7\/files\?per_page=100&page=1$/);
    const body = calls[1]?.body as {
      head_sha: string;
      conclusion: string;
      output: { annotations: { path: string; start_line: number }[] };
    };
    assert.equal(body.head_sha, "b".repeat(40));
    assert.equal(body.conclusion, "neutral");
    assert.deepEqual(
      body.output.annotations.map((a) => [a.path, a.start_line]),
      [["package.json", 12]],
    );
  });

  it("skips the check run on fork PRs and exits 0", async () => {
    const eventPath = await writeEvent({
      pull_request: { number: 7, head: { sha: "b".repeat(40), repo: { fork: true } } },
    });
    setEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath });
    mockFetch(() => ({ status: 403, body: { message: "Resource not accessible" } }));
    const code = await main(await writeResult({ ...cleanResult, findings: [unusedFinding] }));
    assert.equal(code, 0);
    assert.equal(calls.length, 0, "no API calls on fork PRs");
    const summary = await readFile(join(dir, "summary"), "utf8");
    assert.match(summary, /dependency finding/);
  });

  it("renders a CLI error object as a neutral could-not-run check", async () => {
    mockFetch(() => ({ status: 201, body: { id: 1 } }));
    const code = await main(
      await writeResult({
        error: { code: "not-implemented", message: "no adapter for ecosystem" },
      }),
    );
    assert.equal(code, 0);
    const body = calls[0]?.body as { conclusion: string; output: { title: string } };
    assert.equal(body.conclusion, "neutral");
    assert.equal(body.output.title, "GhostDeps could not run");
  });

  it("renders unreadable output as a neutral could-not-run check", async () => {
    mockFetch(() => ({ status: 201, body: { id: 1 } }));
    const code = await main(await writeResult("not json {"));
    assert.equal(code, 0);
    const body = calls[0]?.body as { conclusion: string };
    assert.equal(body.conclusion, "neutral");
  });

  it("paginates PR files up to five pages and notes truncation", async () => {
    const eventPath = await writeEvent({
      pull_request: { number: 7, head: { sha: "b".repeat(40), repo: { fork: false } } },
    });
    setEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath });
    mockFetch((c) => {
      const m = /page=(\d)/.exec(c.url);
      if (m)
        return { status: 200, body: Array.from({ length: 100 }, () => ({ filename: "x.ts" })) };
      return { status: 201, body: { id: 1 } };
    });
    const code = await main(await writeResult(cleanResult));
    assert.equal(code, 0);
    assert.equal(calls.filter((c) => c.url.includes("/files?")).length, 5);
    const body = calls.at(-1)?.body as { output: { summary: string } };
    assert.match(body.output.summary, /truncated at 500 files/);
  });

  it("throws ActionError on API failure (non-fork)", async () => {
    mockFetch(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    await assert.rejects(async () => main(await writeResult(cleanResult)), /check-runs -> 403/);
  });
});
