import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidMarker } from "./marker-syntax.js";

describe("isValidMarker", () => {
  it("accepts PEP 508 markers", () => {
    for (const text of [
      "python_version >= '3.11'",
      'sys_platform == "win32"',
      "'x' in platform_version",
      "os_name not in 'a b'",
      "(os_name == 'nt' or os_name == 'posix') and python_version < '3.11'",
      "extra == 'speed'",
      "'3.10' <= python_version",
    ])
      assert.ok(isValidMarker(text), text);
  });

  it("rejects text that is not a marker", () => {
    for (const text of [
      "",
      "python_version",
      "python_version < 3.11",
      "sys_platform == win32",
      "python_version >=",
      "(os_name == 'nt'",
      "os_name == 'nt')",
      "os_name == 'nt' and",
      "bogus == 'x'",
      "os_name = 'nt'",
      "os_name == 'nt' python_version == '3'",
      "os_name == 'a\nb'",
    ])
      assert.ok(!isValidMarker(text), text);
  });

  it("treats very deep nesting as invalid instead of overflowing the stack", () => {
    const deep = `${"(".repeat(20000)}os_name == 'nt'${")".repeat(20000)}`;
    assert.equal(isValidMarker(deep), false);
    const ok = `${"(".repeat(10)}os_name == 'nt'${")".repeat(10)}`;
    assert.equal(isValidMarker(ok), true);
  });
});
