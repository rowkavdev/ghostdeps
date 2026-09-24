import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnalysisJob } from "../jobs.js";
import {
  decide,
  preFilter,
  PUSH_PAYLOAD_COMMIT_CAP,
  withRerunSourceOnly,
  type Candidate,
  type ChangedFilesLookup,
} from "./filter.js";
import { isAnalysableSource, isDependencyFile } from "./manifests.js";

const repository = { id: 9, name: "demo", owner: { login: "acme" }, default_branch: "main" };
const installation = { id: 42 };
const HEAD = "c".repeat(40);

function pr(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    number: 7,
    installation,
    repository,
    pull_request: { number: 7, head: { sha: HEAD }, base: { sha: "b".repeat(40) } },
    ...extra,
  };
}

function push(extra: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: HEAD,
    deleted: false,
    installation,
    repository,
    commits: [{ added: [], modified: ["src/index.ts"], removed: [] }],
    ...extra,
  };
}

const noLookup: ChangedFilesLookup = async () => {
  throw new Error("lookup must not be called");
};
const files =
  (list: string[], complete = true): ChangedFilesLookup =>
  async () => ({ files: list, complete });

describe("isDependencyFile", () => {
  it("matches manifests and lockfiles at any depth", () => {
    for (const p of [
      "package.json",
      "packages/web/package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "services/api/pyproject.toml",
      "uv.lock",
      "poetry.lock",
      "Pipfile.lock",
      "requirements.txt",
      "requirements-dev.txt",
      "requirements/base.txt",
      "dev-requirements.in",
      "crates/x/Cargo.toml",
      "Cargo.lock",
      "go.mod",
      "go.sum",
    ]) {
      assert.equal(isDependencyFile(p), true, p);
    }
  });

  it("ignores source, docs and look-alikes", () => {
    for (const p of [
      "src/index.ts",
      "README.md",
      "package.json.bak",
      "docs/requirements.md",
      "my-package.json",
      "go.mod.orig",
    ]) {
      assert.equal(isDependencyFile(p), false, p);
    }
  });
});

describe("isAnalysableSource (#101)", () => {
  it("matches JS/TS source at any depth, including declaration files", () => {
    for (const p of [
      "a.ts",
      "src/a.tsx",
      "lib/b.mjs",
      "c.cjs",
      "x/y.jsx",
      "types/z.d.ts",
      "m.mts",
      "n.cts",
      "k.js",
    ]) {
      assert.equal(isAnalysableSource(p), true, p);
    }
  });
  it("ignores installs, build output, vendored code, bundles and non-source", () => {
    for (const p of [
      "node_modules/a/index.js",
      "packages/x/dist/index.js",
      "build/a.js",
      "vendor/lib.js",
      "public/app.min.js",
      "a.js.map",
      "README.md",
      "src/a.py",
      "styles.css",
    ]) {
      assert.equal(isAnalysableSource(p), false, p);
    }
  });
});

describe("preFilter", () => {
  it("accepts pull_request opened, synchronize and reopened", () => {
    for (const a of ["opened", "synchronize", "reopened"]) {
      const r = preFilter("pull_request", pr(a));
      assert.ok("candidate" in r, a);
      assert.equal(r.candidate.key, `9:${HEAD}`);
      assert.equal(r.candidate.installationId, 42);
    }
  });

  it("default-denies other pull_request actions and other events", () => {
    for (const a of [
      "closed",
      "labeled",
      "edited",
      "assigned",
      "ready_for_review",
      "future_action",
    ]) {
      assert.ok("skip" in preFilter("pull_request", pr(a)), a);
    }
    for (const e of [
      "issues",
      "issue_comment",
      "check_suite",
      "check_run",
      "workflow_run",
      "create",
    ]) {
      assert.ok("skip" in preFilter(e, { action: "created", repository, installation }), e);
    }
  });

  it("only accepts branch pushes to the default branch", () => {
    assert.ok("candidate" in preFilter("push", push()));
    assert.ok("skip" in preFilter("push", push({ ref: "refs/heads/feature" })));
    assert.ok("skip" in preFilter("push", push({ ref: "refs/tags/v1.0.0" })));
    assert.ok("skip" in preFilter("push", push({ deleted: true })));
    assert.ok("skip" in preFilter("push", push({ after: "0".repeat(40) })));
    assert.ok("skip" in preFilter("push", push({ before: "0".repeat(40) })));
  });

  it("records the push trigger with its before SHA", () => {
    const r = preFilter("push", push());
    assert.ok("candidate" in r);
    assert.deepEqual(r.candidate.trigger, {
      kind: "push",
      ref: "refs/heads/main",
      beforeSha: "a".repeat(40),
    });
  });

  it("skips malformed payloads without throwing", () => {
    assert.ok("skip" in preFilter("pull_request", { action: "opened" }));
    assert.ok("skip" in preFilter("pull_request", { ...pr("opened"), installation: undefined }));
    assert.ok("skip" in preFilter("push", {}));
    assert.ok("skip" in preFilter("push", null));
  });
});

describe("decide", () => {
  it("analyses a PR that touches a lockfile", async () => {
    const d = await decide(
      "pull_request",
      pr("synchronize"),
      "g1",
      files(["src/a.ts", "pnpm-lock.yaml"]),
    );
    assert.equal(d.analyse, true);
    if (d.analyse) {
      assert.deepEqual(d.dependencyFiles, ["pnpm-lock.yaml"]);
      assert.equal(d.job.deliveryId, "g1");
      assert.equal("payloadFiles" in d.job, false);
    }
  });

  it("skips a source-only PR while the source trigger is off (the default)", async () => {
    const d = await decide("pull_request", pr("opened"), "g1", files(["src/a.ts", "README.md"]));
    assert.deepEqual(d, { analyse: false, reason: "no dependency manifest or lockfile changed" });
  });

  it("analyses a source-only PR with the source trigger on (#101)", async () => {
    const d = await decide("pull_request", pr("opened"), "g1", files(["src/a.ts", "README.md"]), {
      sourcePrTrigger: true,
    });
    assert.equal(d.analyse, true);
    if (d.analyse) {
      assert.deepEqual(d.dependencyFiles, []);
      assert.deepEqual(d.sourceFiles, ["src/a.ts"]);
      assert.equal(d.job.trigger.kind === "pull_request" && d.job.trigger.sourceOnly, true);
    }
  });

  it("marks a PR source-only only when the complete list has no dependency file", async () => {
    const withManifest = await decide(
      "pull_request",
      pr("opened"),
      "g1",
      files(["src/a.ts", "package.json"]),
      { sourcePrTrigger: true },
    );
    const capped = await decide(
      "pull_request",
      pr("opened"),
      "g1",
      async () => ({ files: ["src/a.ts"], complete: false }),
      { sourcePrTrigger: true },
    );
    for (const d of [withManifest, capped]) {
      assert.equal(d.analyse, true);
      if (d.analyse) assert.equal("sourceOnly" in d.job.trigger, false);
    }
  });

  it("with the trigger on, skips a PR that touches neither dependency files nor analysable source", async () => {
    const d = await decide(
      "pull_request",
      pr("opened"),
      "g1",
      files(["README.md", "docs/x.md", "dist/index.js", "node_modules/a/index.js", "app.min.js"]),
      { sourcePrTrigger: true },
    );
    assert.deepEqual(d, {
      analyse: false,
      reason: "no dependency manifest, lockfile or analysable source changed",
    });
  });

  it("keeps pushes manifest-only: source-only pushes are skipped", async () => {
    const d = await decide("push", push(), "g1", noLookup, { sourcePrTrigger: true });
    assert.deepEqual(d, { analyse: false, reason: "no dependency manifest or lockfile changed" });
  });

  it("analyses when the file list was capped, even with no manifest in it", async () => {
    const d = await decide("pull_request", pr("opened"), "g1", files(["src/a.ts"], false));
    assert.equal(d.analyse, true);
  });

  it("analyses when the lookup fails", async () => {
    const d = await decide("pull_request", pr("opened"), "g1", async () => {
      throw new Error("502");
    });
    assert.equal(d.analyse, true);
  });

  it("uses complete push payload files without a lookup", async () => {
    assert.equal(
      (await decide("push", push({ commits: [{ modified: ["go.mod"] }] }), "g", noLookup)).analyse,
      true,
    );
    assert.equal((await decide("push", push(), "g", noLookup)).analyse, false);
  });

  it("looks files up when the push payload may be truncated", async () => {
    const commits = Array.from({ length: PUSH_PAYLOAD_COMMIT_CAP }, () => ({
      modified: ["src/x.ts"],
    }));
    let called = false;
    const d = await decide("push", push({ commits }), "g", async () => {
      called = true;
      return { files: ["Cargo.lock"], complete: true };
    });
    assert.equal(called, true);
    assert.equal(d.analyse, true);
  });

  it("never looks anything up for filtered-out events", async () => {
    assert.equal((await decide("pull_request", pr("closed"), "g", noLookup)).analyse, false);
    assert.equal(
      (await decide("push", push({ ref: "refs/heads/dev" }), "g", noLookup)).analyse,
      false,
    );
  });
});

describe("withRerunSourceOnly (#196)", () => {
  const rerun: AnalysisJob = {
    key: "k",
    deliveryId: "d",
    installationId: 1,
    repository: { id: 2, owner: "o", name: "r" },
    headSha: "a".repeat(40),
    trigger: {
      kind: "rerequested",
      checkRunId: 3,
      pullRequest: { number: 42, baseSha: "b".repeat(40) },
    },
  };
  const flag = (j: AnalysisJob) =>
    j.trigger.kind === "rerequested" ? j.trigger.pullRequest?.sourceOnly : "not a re-run";

  it("flags a re-run whose complete PR file list is source-only, via the first run's lookup", async () => {
    const asked: Candidate[] = [];
    const out = await withRerunSourceOnly(
      rerun,
      async (c) => {
        asked.push(c);
        return { files: ["src/a.ts"], complete: true };
      },
      { sourcePrTrigger: true },
    );
    assert.equal(flag(out), true);
    assert.equal(asked[0]?.trigger.kind === "pull_request" && asked[0].trigger.number, 42);
  });

  it("leaves it unflagged for a manifest, a capped list, a failed lookup or the trigger off", async () => {
    const cases: [ChangedFilesLookup, boolean][] = [
      [async () => ({ files: ["src/a.ts", "package.json"], complete: true }), true],
      [async () => ({ files: ["src/a.ts"], complete: false }), true],
      [async () => Promise.reject(new Error("boom")), true],
      [async () => ({ files: ["src/a.ts"], complete: true }), false],
    ];
    for (const [lookup, on] of cases) {
      const out = await withRerunSourceOnly(rerun, lookup, { sourcePrTrigger: on });
      assert.equal(flag(out), undefined);
    }
  });
});
