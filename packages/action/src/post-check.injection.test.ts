import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./post-check.js";
import type { AnalysisResult, Finding } from "@ghostdeps/core";

const evilFile = "evil%,title=fake.ts\r\n::error title=pwned::injected";

const result: AnalysisResult = {
  schemaVersion: 1,
  projects: [],
  dependencies: [],
  usages: [],
  detected: [],
  surface: [],
  findings: [
    {
      kind: "unused",
      dependency: "left-pad",
      summary: "left-pad is declared but never imported",
      recommendation: "Remove left-pad from dependencies",
      evidence: [{ kind: "declared", statement: "imported here", file: evilFile, line: 1 }],
      confidence: "high",
      limitations: [],
      affectedFiles: [evilFile],
    } as Finding,
  ],
};

let dir: string;
let originalEnv: NodeJS.ProcessEnv;
let originalFetch: typeof fetch;
let originalLog: typeof console.log;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ghostdeps-action-injection-"));
  originalEnv = { ...process.env };
  originalFetch = globalThis.fetch;
  originalLog = console.log;
});

afterEach(async () => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  await rm(dir, { recursive: true, force: true });
});

describe("fork-PR workflow-command fallback", () => {
  it("cannot inject workflow commands through a crafted file path", async () => {
    const eventPath = join(dir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        pull_request: { number: 7, head: { sha: "b".repeat(40), repo: { fork: true } } },
      }),
    );
    for (const k of ["GITHUB_API_URL", "GHOSTDEPS_CHECK_NAME"]) delete process.env[k];
    Object.assign(process.env, {
      GHOSTDEPS_GITHUB_TOKEN: "ghs_test",
      GITHUB_REPOSITORY: "acme/demo",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    });
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes("/pulls/7/files")) {
        return new Response(JSON.stringify([{ filename: evilFile, patch: "@@ -0,0 +1 @@\n+x" }]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    }) as typeof fetch;

    const printed: string[] = [];
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
    const resultPath = join(dir, "result.json");
    await writeFile(resultPath, JSON.stringify(result));
    const code = await main(resultPath);
    assert.equal(code, 0);
    const notice = printed.find((entry) => entry.startsWith("::notice "));
    assert.ok(
      notice?.startsWith(
        "::notice file=evil%25%2Ctitle=fake.ts%0D%0A%3A%3Aerror title=pwned%3A%3Ainjected,line=1,title=",
      ),
      `annotation property escaping is incomplete: ${notice}`,
    );
    const lines = printed.flatMap((entry) => entry.split("\n"));
    assert.ok(
      !lines.some((line) => line.startsWith("::error")),
      `workflow command injected through annotation path:\n${lines.join("\n")}`,
    );
  });
});
