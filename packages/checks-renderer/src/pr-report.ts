import { findingGroup, type AnalysisResult, type Finding } from "@ghostdeps/core";
import { incompleteTitle, md, plain, truncateSummary, type CheckOutput } from "./render.js";

export interface PrReportInput {
  botLogin: string;
  channel: "action" | "app";
  sha: string;
  rendered: CheckOutput;
  result?: AnalysisResult;
  repositoryUrl?: string;
}

function reportStatus(input: PrReportInput, notes: readonly Finding[]) {
  const clean = input.rendered.conclusion === "success";
  const unavailable = !input.result;
  const coverageGap =
    input.rendered.output.title === incompleteTitle ||
    notes.some((f) => findingGroup(f) === "incomplete") ||
    (input.result?.scanScope?.excludedFiles ?? 0) > 0 ||
    (input.result?.nativeEvaluations?.some((n) => n.status !== "produced") ?? false);
  const status = unavailable
    ? "Scan unavailable"
    : clean
      ? "No significant issues found"
      : coverageGap
        ? "Review coverage gaps"
        : "Dependency findings to review";
  const description = unavailable
    ? "GhostDeps could not complete this scan. Open the analysis details for the reason."
    : coverageGap
      ? "Some references could not be verified. Review the notes before removing dependencies."
      : clean
        ? "No significant dependency issues were found in the analysed scope."
        : "Review the findings below alongside their confidence and evidence.";
  return { status, description, unavailable, coverageGap };
}

function commitLabel(input: PrReportInput): string {
  const repoUrl =
    input.repositoryUrl &&
    /^https:\/\/[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(input.repositoryUrl)
      ? input.repositoryUrl
      : undefined;
  const commit = repoUrl
    ? `[\`${input.sha.slice(0, 7)}\`](${repoUrl}/commit/${input.sha})`
    : `\`${input.sha.slice(0, 7)}\``;
  return commit;
}

function findingRows(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  if (findings.length) {
    lines.push(
      "",
      "### Findings",
      "",
      "| Dependency | Finding | Confidence |",
      "| :--- | :--- | :--- |",
    );
    for (const f of findings.slice(0, 10))
      lines.push(
        `| ${field(f.dependency ?? "Repository", 160)} | ${field(f.summary, 400)} | ${field(f.confidence ?? "unspecified", 40)} |`,
      );
    if (findings.length > 10)
      lines.push("", `_${findings.length - 10} more findings in the analysis details._`);
  }
  return lines;
}

function coverageRows(notes: readonly Finding[]): string[] {
  const lines: string[] = [];
  if (notes.length) {
    lines.push("", "### Coverage notes", "");
    for (const f of notes.slice(0, 8))
      lines.push(
        `- ${f.dependency ? `**${field(f.dependency, 160)}** — ` : ""}${field(f.summary, 600)}`,
      );
    if (notes.length > 8) lines.push(`- ${notes.length - 8} more notes in the analysis details.`);
  }
  return lines;
}

/** A compact overview, visible coverage reasons, and optional full check detail. */
const field = (value: string, limit: number) => md(plain(value, limit));

export function renderPrReport(input: PrReportInput): string {
  if (!/^[a-f0-9]{40,64}$/i.test(input.sha)) throw new Error("invalid analysed SHA");
  const marker = `<!-- ghostdeps:report:${input.channel}:v1 -->`;
  const findings = input.result?.findings.filter((f) => findingGroup(f) === "verdict") ?? [];
  const notes =
    input.result?.findings.filter((f) => ["incomplete", "note"].includes(findingGroup(f))) ?? [];
  const { status, description, unavailable, coverageGap } = reportStatus(input, notes);
  const commit = commitLabel(input);
  const lines = [
    marker,
    "## 👻 GhostDeps",
    "",
    `**${status}**`,
    "",
    description,
    "",
    "| Dependency findings | Coverage | Analysed commit |",
    "| :--- | :--- | :--- |",
    `| ${unavailable ? "—" : findings.length} | ${unavailable ? "Unavailable" : coverageGap ? "Needs review" : "No reported gaps"} | ${commit} |`,
  ];
  lines.push(...findingRows(findings), ...coverageRows(notes));
  lines.push(
    "",
    "<details>",
    "<summary>Analysis details and evidence</summary>",
    "",
    truncateSummary(input.rendered.output.summary, 45000),
    "",
    "</details>",
    "",
    "<sub>Advisory report · Updated in place when the PR changes · GhostDeps never blocks merging</sub>",
    "",
  );
  return lines.join("\n");
}

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
  input: PrReportInput,
): Promise<"created" | "updated" | "unchanged"> {
  const marker = `<!-- ghostdeps:report:${input.channel}:v1 -->`;
  const body = renderPrReport(input);
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
