import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parse } from "yaml";

/** Row labels in the docs/github-app.md permissions table -> manifest permission keys. */
const DOC_LABEL_TO_KEY: Record<string, string> = {
  "Repository contents": "contents",
  Issues: "issues",
  "Pull requests": "pull_requests",
  Checks: "checks",
  Metadata: "metadata",
};

/** Delivered to every app without being listed in the manifest. */
const IMPLICIT_EVENTS = new Set(["installation", "installation_repositories"]);

interface Manifest {
  default_events: string[];
  default_permissions: Record<string, string>;
}

async function load(): Promise<{ manifest: Manifest; doc: string }> {
  const [yml, doc] = await Promise.all([
    readFile(new URL("../app.yml", import.meta.url), "utf8"),
    readFile(new URL("../../../docs/github-app.md", import.meta.url), "utf8"),
  ]);
  return { manifest: parse(yml) as Manifest, doc };
}

function section(doc: string, heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `docs/github-app.md has no "## ${heading}" section`);
  const next = doc.indexOf("\n## ", start + 3);
  return doc.slice(start, next === -1 ? undefined : next);
}

function documentedPermissions(doc: string): Record<string, string> {
  const rows = section(doc, "Permissions")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2); // header + separator
  const permissions: Record<string, string> = {};
  for (const row of rows) {
    const [label, access] = row
      .split("|")
      .slice(1, 3)
      .map((cell) => cell.trim());
    assert.ok(label && access, `malformed permissions row: ${row}`);
    const key = DOC_LABEL_TO_KEY[label];
    assert.ok(key, `unknown permission "${label}" in docs; add it to DOC_LABEL_TO_KEY`);
    permissions[key] = access.toLowerCase();
  }
  return permissions;
}

function documentedEvents(doc: string): Set<string> {
  const events = new Set<string>();
  for (const line of section(doc, "Webhook events").split("\n")) {
    if (!line.startsWith("- ")) continue;
    for (const match of line.matchAll(/`([a-z_]+)`/g)) {
      // Action qualifiers describe handler policy, not a distinct webhook event.
      if (match[1] && match[1] !== "edited") events.add(match[1]);
    }
  }
  return events;
}

describe("app manifest", () => {
  it("requests exactly the permissions documented in docs/github-app.md", async () => {
    const { manifest, doc } = await load();
    assert.deepEqual(manifest.default_permissions, documentedPermissions(doc));
  });

  it("requests only the documented scoped comment/dispatch permission delta", async () => {
    const { manifest } = await load();
    assert.deepEqual(manifest.default_permissions, {
      contents: "write",
      pull_requests: "read",
      checks: "write",
      issues: "write",
      metadata: "read",
    });
  });

  it("subscribes to exactly the documented events", async () => {
    const { manifest, doc } = await load();
    const expected = [...documentedEvents(doc)].filter((e) => !IMPLICIT_EVENTS.has(e)).sort();
    assert.deepEqual([...manifest.default_events].sort(), expected);
    assert.deepEqual(expected, ["check_run", "issue_comment", "pull_request", "push"]);
  });

  it("documents the implicit installation events", async () => {
    const { doc } = await load();
    const events = documentedEvents(doc);
    for (const event of IMPLICIT_EVENTS) assert.ok(events.has(event), `${event} not documented`);
  });
});
