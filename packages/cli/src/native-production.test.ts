import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { analysePath, runScan } from "./scan.js";
import { run } from "./cli.js";
import { renderJsonReport } from "@ghostdeps/core";

describe("production CLI native evaluation (#462)", () => {
  it("exposes a real gated finding and blocked outcome as JSON and human text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ghostdeps-native-cli-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "package.json"), '{"dependencies":{"axios":"^1.0.0"}}');
      await writeFile(
        path.join(root, "ghostdeps.targets.json"),
        JSON.stringify({
          schemaVersion: 1,
          complete: true,
          targets: [{ id: "production", runtime: "node", minVersion: "22.0.0" }],
        }),
      );
      await writeFile(
        path.join(root, "src/a.ts"),
        'import axios from "axios"; async function f() { const res = await axios.get("/x"); if (res.status === 200) return res.data; }',
      );
      const result = await analysePath(root);
      assert.equal(result.nativeEvaluations?.[0]?.status, "produced");
      assert.ok(
        result.findings.some(
          (f) =>
            f.kind === "potentially-unnecessary" &&
            f.rule === result.nativeEvaluations?.[0]?.ruleId,
        ),
      );
      const json = JSON.parse(renderJsonReport(result)) as typeof result;
      assert.equal(json.nativeEvaluations?.[0]?.status, "produced");
      assert.ok(
        json.findings.some((f) =>
          f.evidence.some((e) => e.kind === "native-incompatibility-excluded"),
        ),
      );
      const rule = "javascript-typescript/axios-to-fetch/v1";
      const capture = async (flags: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(["scan", "--json", ...flags, root], {
          stdout: (line) => void out.push(line),
          stderr: (line) => void err.push(line),
        });
        assert.equal(code, 0, err.join("\n"));
        return JSON.parse(out.join("\n")) as typeof result;
      };
      const disabled = await capture(["--disable-rule", rule]);
      assert.ok(!disabled.findings.some((f) => f.rule === rule));
      const downgraded = await capture(["--downgrade", `${rule}=low`]);
      const downgradedFinding = downgraded.findings.find((f) => f.rule === rule);
      assert.equal(downgradedFinding?.confidence, "low");
      assert.equal(downgradedFinding?.severity, "info");
      assert.equal(downgraded.nativeEvaluations?.[0]?.status, "produced");
      await writeFile(
        path.join(root, "ghostdeps.targets.json"),
        JSON.stringify({
          schemaVersion: 1,
          complete: true,
          targets: [{ id: "production", runtime: "node", minVersion: "18.0.0" }],
        }),
      );
      const blocked = await analysePath(root);
      assert.equal(blocked.nativeEvaluations?.[0]?.status, "blocked");
      assert.ok(!blocked.findings.some((f) => f.rule === result.nativeEvaluations?.[0]?.ruleId));
      const out: string[] = [];
      const code = await runScan(
        { path: root, command: "scan", json: false } as Parameters<typeof runScan>[0],
        { stdout: (s) => void out.push(s), stderr: () => {} },
      );
      assert.equal(code, 0);
      assert.match(
        out.join("\n"),
        /Native evaluation:\n {2}axios .*blocked in deployment \(below-floor\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
