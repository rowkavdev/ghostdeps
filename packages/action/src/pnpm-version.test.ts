/**
 * The composite action pins pnpm explicitly because pnpm/action-setup
 * resolves package_json_file relative to the CONSUMER's workspace, never the
 * action repo's. This test pins the pin: action.yml's pnpm version must equal
 * the root package.json packageManager field, so the two cannot drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ACTION_YML = new URL("../action.yml", import.meta.url).pathname;
const ROOT_PKG = new URL("../../../package.json", import.meta.url).pathname;

describe("action pnpm version pin", () => {
  it("matches the root packageManager field", () => {
    const yml = readFileSync(ACTION_YML, "utf8");
    const setupBlock = yml.match(
      /- uses: pnpm\/action-setup@[0-9a-f]{40} # v4\s+with:\s+version: (\S+)/,
    );
    assert.ok(setupBlock, "action.yml must pin pnpm/action-setup with version:");
    const pkg = JSON.parse(readFileSync(ROOT_PKG, "utf8")) as {
      packageManager?: string;
    };
    const pm = pkg.packageManager;
    assert.ok(pm, "root package.json must declare packageManager");
    assert.ok(pm.startsWith("pnpm@"));
    assert.equal(setupBlock[1], pm.slice("pnpm@".length));
  });
});
