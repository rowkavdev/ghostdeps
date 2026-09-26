/**
 * Comment delivery wiring (slice 3, gated): after a PR check completes, the
 * worker hands the SAME AnalysisResult here. Eligibility comes from core's
 * fix preview per candidate finding - never from display severity - and the
 * comment is maintained through a client narrowed to issues:write. Any
 * failure is logged and the check result stands: comments are additive.
 */
import { previewNpmRemoval, type AnalysisResult, type EcosystemAdapter } from "@ghostdeps/core";
import { FsRepositoryHandle } from "@ghostdeps/core";
import { createGoAdapter } from "@ghostdeps/go";
import { createJavaScriptTypeScriptAdapter } from "@ghostdeps/javascript-typescript";
import { createPythonAdapter } from "@ghostdeps/python";
import { createRustAdapter } from "@ghostdeps/rust";

/** Adapter instances for fix-preview revalidation (same set the worker isolates). */
export function defaultCommentAdapters(): EcosystemAdapter[] {
  return [
    createJavaScriptTypeScriptAdapter(),
    createRustAdapter(),
    createGoAdapter(),
    createPythonAdapter(),
  ];
}
import { renderPrComment, TICKABLE_RULES, type FindingEligibility } from "./render.js";
import { eligibilityId, resolveFindingDeclaration } from "./resolve.js";
import { parseMarker } from "./marker.js";
import { maintainComment, type IssuesClient, type MaintainOutcome } from "./state.js";

/** Bound on per-PR fix previews; each preview revalidates evidence itself. */
const MAX_ELIGIBILITY_CANDIDATES = 10;

export interface CommenterOptions {
  readonly botLogin: string;
  readonly log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export interface CommentJob {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: number;
  readonly pullNumber: number;
  readonly headSha: string;
}

/**
 * Per-finding fix eligibility for the comment. Candidates are tickable-rule
 * findings only, capped; every refusal becomes the finding's displayed
 * "no tickbox" reason. A candidate that errors is ineligible, never tickable.
 */
export async function computeEligibility(
  root: string,
  adapters: readonly EcosystemAdapter[],
  result: AnalysisResult,
): Promise<Map<string, FindingEligibility>> {
  const map = new Map<string, FindingEligibility>();
  const candidates = result.findings.filter(
    (f) => f.dependency !== undefined && f.rule !== undefined && TICKABLE_RULES.has(f.rule),
  );
  let handle: FsRepositoryHandle | undefined;
  let previews = 0;
  for (const f of candidates) {
    // The project dimension is load-bearing (reviewer-1 #425): a root
    // preview must never stamp eligibility onto another project's
    // same-named declaration.
    const decl = resolveFindingDeclaration(result, f);
    if (decl.status !== "resolved") continue; // the renderer explains it
    const id = eligibilityId(f.rule!, decl.dependency.project.path, f.dependency!);
    if (map.has(id)) continue;
    if (decl.dependency.project.path !== ".") {
      map.set(id, {
        status: "ineligible",
        reason: "only the root npm package layout is supported in this preview",
      });
      continue;
    }
    if (previews >= MAX_ELIGIBILITY_CANDIDATES) {
      map.set(id, { status: "ineligible", reason: "beyond this run's evaluation budget" });
      continue;
    }
    previews += 1;
    try {
      handle ??= await FsRepositoryHandle.open(root);
      const preview = await previewNpmRemoval(handle, adapters, f.dependency!);
      map.set(
        id,
        preview.status === "statically-checked"
          ? { status: "eligible", key: preview.key! }
          : { status: "ineligible", reason: preview.reason ?? "preview refused" },
      );
    } catch {
      map.set(id, { status: "ineligible", reason: "eligibility could not be verified" });
    }
  }
  return map;
}

/** Render and maintain the PR comment. Exported for the worker's post-check step. */
export async function deliverComment(
  client: IssuesClient,
  options: CommenterOptions,
  job: CommentJob,
  root: string,
  adapters: readonly EcosystemAdapter[],
  result: AnalysisResult,
): Promise<MaintainOutcome> {
  const eligibility = await computeEligibility(root, adapters, result);
  const body = renderPrComment({
    result,
    repositoryId: job.repositoryId,
    pullNumber: job.pullNumber,
    headSha: job.headSha,
    eligibility,
    applyAvailable: false, // Slice 3: no dispatch anywhere yet; the footer says so.
  });
  const marker = parseMarker(body);
  if (!marker) throw new Error("rendered comment has no valid marker");
  return maintainComment(client, {
    owner: job.owner,
    repo: job.repo,
    pullNumber: job.pullNumber,
    botLogin: options.botLogin,
    body,
    marker,
  });
}
