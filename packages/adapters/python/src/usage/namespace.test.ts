import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterContext, Dependency, ProjectRef, SourceLineChanges } from "@ghostdeps/core";
import { findPythonUsage } from "./scan.js";
import { memoryHandle } from "../testing/fs-handle.js";

const root: ProjectRef = { path: ".", ecosystem: "python", packageManagers: [] };
const dep = (name: string): Dependency => ({
  name,
  constraint: "*",
  kind: "runtime",
  project: root,
  declaredIn: "requirements.txt",
});
const REQS = "google-cloud-storage\ngoogle-cloud-bigquery\nprotobuf\nrequests\n";

function context(files: Record<string, string>, changes?: SourceLineChanges[]): AdapterContext {
  const ctx: AdapterContext = { repository: memoryHandle(files), network: { mode: "offline" } };
  if (changes) ctx.pullRequestSourceChanges = changes;
  return ctx;
}
const usageOf = async (source: string, name: string) =>
  (await findPythonUsage(context({ "requirements.txt": REQS, "app.py": source }), dep(name)))
    .filter((u) => u.removedInPr !== true)
    .map((u) => [u.line, u.form, u.symbols]);

describe("namespace from-imports", () => {
  it("credits a member imported from a namespace package", async () => {
    const src = "from google.cloud import storage\n";
    assert.deepEqual(await usageOf(src, "google-cloud-storage"), [[1, "static", ["storage"]]]);
    assert.deepEqual(await usageOf(src, "google-cloud-bigquery"), []);
    assert.deepEqual(await usageOf(src, "protobuf"), []);
    assert.deepEqual(await usageOf("from google import protobuf\n", "protobuf"), [
      [1, "static", ["protobuf"]],
    ]);
    assert.deepEqual(await usageOf("import google.cloud.storage\n", "google-cloud-storage"), [
      [1, "static", []],
    ]);
  });

  it("credits each member to its own distribution in a mixed import", async () => {
    const src = "from google.cloud import storage, bigquery, firestore\n";
    assert.deepEqual(await usageOf(src, "google-cloud-storage"), [[1, "static", ["storage"]]]);
    assert.deepEqual(await usageOf(src, "google-cloud-bigquery"), [[1, "static", ["bigquery"]]]);
    assert.deepEqual(await usageOf(src, "protobuf"), []);
  });

  it("handles aliases, parentheses and continuation lines", async () => {
    assert.deepEqual(
      await usageOf("from google.cloud import storage as gcs\n", "google-cloud-storage"),
      [[1, "static", ["storage"]]],
    );
    assert.deepEqual(
      await usageOf(
        "from google.cloud import (\n    storage as s,\n    bigquery,\n)\n",
        "google-cloud-bigquery",
      ),
      [[1, "static", ["bigquery"]]],
    );
  });

  it("does not credit siblings or the bare namespace", async () => {
    for (const src of [
      "from google.cloud import firestore\n",
      "from google.cloud import storage_extras\n",
      "from google import genai\n",
      "from google.cloud import *\n",
      "from google import cloud\n",
      "import google\n",
    ]) {
      for (const name of ["google-cloud-storage", "google-cloud-bigquery", "protobuf"]) {
        assert.deepEqual(await usageOf(src, name), [], `${src} -> ${name}`);
      }
    }
  });

  it("keeps base resolution for ordinary symbols", async () => {
    assert.deepEqual(
      await usageOf("from google.cloud.storage import Client, Blob\n", "google-cloud-storage"),
      [[1, "static", ["Blob", "Client"]]],
    );
    assert.deepEqual(await usageOf("from google.protobuf import message\n", "protobuf"), [
      [1, "static", ["message"]],
    ]);
    assert.deepEqual(await usageOf("from requests import get\n", "requests"), [
      [1, "static", ["get"]],
    ]);
  });

  it("resolves removed lines the same way", async () => {
    const ctx = context({ "requirements.txt": REQS, "app.py": "" }, [
      {
        path: "old.py",
        removedLines: [
          { line: 1, text: "from google.cloud import storage, firestore" },
          { line: 2, text: "from google import genai" },
        ],
        addedLines: [],
      },
    ]);
    const removed = async (name: string) =>
      (await findPythonUsage(ctx, dep(name)))
        .filter((u) => u.removedInPr === true)
        .map((u) => [u.file, u.line, u.symbols]);
    assert.deepEqual(await removed("google-cloud-storage"), [["old.py", 1, ["storage"]]]);
    assert.deepEqual(await removed("google-cloud-bigquery"), []);
    assert.deepEqual(await removed("protobuf"), []);
  });
});
