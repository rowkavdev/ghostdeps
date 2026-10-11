import type { CheckOutput } from "./render.js";

/** Minimal issues client, shared by the Action and the App's issues-only token. */
export interface ReportClient {
  listComments(
    page: number,
  ): Promise<{ id: number; body?: string | null; user?: { login?: string } | null }[]>;
  createComment(body: string): Promise<unknown>;
  updateComment(id: number, body: string): Promise<unknown>;
}

/** One reporting-only comment per channel. Never offers apply controls. */
export async function maintainPrReport(
  client: ReportClient,
  input: { botLogin: string; channel: "action" | "app"; sha: string; rendered: CheckOutput },
): Promise<"created" | "updated" | "unchanged"> {
  if (!/^[a-f0-9]{40,64}$/i.test(input.sha)) throw new Error("invalid analysed SHA");
  const marker = `<!-- ghostdeps:report:${input.channel}:v1 -->`;
  // GitHub's issue-comment limit is 65,536 characters. Leave room for the header.
  const summary = input.rendered.output.summary;
  const bounded =
    summary.length > 60000
      ? summary.slice(0, 60000) + "\n\nReport truncated; see the full GhostDeps check."
      : summary;
  const body = `${marker}\n## GhostDeps: ${input.rendered.output.title}\n\n${bounded}\n\nAnalysed commit: \`${input.sha}\`\n`;
  const owned: { id: number; body?: string | null }[] = [];
  for (let page = 1; page <= 10; page++) {
    const comments = await client.listComments(page);
    if (!Array.isArray(comments)) throw new Error("unexpected comment list");
    owned.push(
      ...comments.filter(
        (c) => c.user?.login === input.botLogin && c.body?.startsWith(marker + "\n"),
      ),
    );
    if (comments.length < 100) break;
    if (page === 10)
      throw new Error("comment discovery incomplete; refusing to create a duplicate");
  }
  if (owned.length > 1) throw new Error("multiple GhostDeps reports; refusing ambiguous update");
  const existing = owned[0];
  if (!existing) {
    await client.createComment(body);
    return "created";
  }
  if (existing.body === body) return "unchanged";
  await client.updateComment(existing.id, body);
  return "updated";
}
