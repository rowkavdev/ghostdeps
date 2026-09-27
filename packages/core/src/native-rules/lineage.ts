/** Byte-bound reconstruction of adapter lineage citations. This is not a JS parser. */
import type { NativeReferenceSpan, NativeLineageChain } from "./matched-api.js";

export type LineageRead = (span: NativeReferenceSpan) => Promise<Uint8Array | null>;
export interface LineageReconstruction {
  readonly status: "core-reconstructed" | "adapter-asserted";
  readonly reason?: string;
}
const identifier = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
const dotted = /^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u;
const contains = (parent: NativeReferenceSpan, child: NativeReferenceSpan): boolean =>
  parent.file === child.file && child.start >= parent.start && child.end <= parent.end;
const decode = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

export async function reconstructLineage(
  chain: NativeLineageChain | undefined,
  packageName: string,
  call: NativeReferenceSpan,
  binding: string,
  read: LineageRead,
): Promise<LineageReconstruction> {
  const refuse = (reason: string): LineageReconstruction => ({
    status: "adapter-asserted",
    reason,
  });
  if (!chain || !Array.isArray(chain.links)) return refuse("lineage chain missing");
  if (chain.brokenAt) {
    const located = await read(chain.brokenAt.span);
    if (!located || typeof chain.brokenAt.reason !== "string" || !chain.brokenAt.reason.trim())
      return refuse("broken chain has invalid break citation or reason");
    return refuse(
      `broken at ${chain.brokenAt.span.file}:${chain.brokenAt.span.start}: ${chain.brokenAt.reason}`,
    );
  }
  if (chain.links.length < 2 || chain.links.length > 64)
    return refuse("lineage chain has no bounded package-entry to call path");
  const links = chain.links;
  if (!["import", "require", "re-export"].includes(links[0]!.kind))
    return refuse("lineage has no package-entry link");
  if (
    links.at(-1)?.kind !== "call" ||
    !contains(call, links.at(-1)!.span) ||
    links.at(-1)!.span.start !== call.start ||
    links.at(-1)!.span.end !== call.end
  )
    return refuse("lineage does not end at cited call");
  for (const [index, link] of links.entries()) {
    if (
      !link ||
      !["import", "require", "alias", "re-export", "wrapper", "call"].includes(link.kind) ||
      typeof link.from !== "string" ||
      typeof link.to !== "string" ||
      !dotted.test(link.from) ||
      !dotted.test(link.to)
    )
      return refuse(`invalid lineage link ${index}`);
    if (
      index &&
      links[index - 1]!.to !== link.from &&
      !(link.kind === "call" && link.from.startsWith(links[index - 1]!.to + ".")) &&
      !(
        link.kind === "wrapper" &&
        links[index - 1]!.kind === "call" &&
        link.from === `${packageName}.${links[index - 1]!.to}`
      )
    )
      return refuse(`lineage gap before link ${index}`);
    const main = await read(link.span);
    const from = await read(link.fromSpan);
    const to = await read(link.toSpan);
    if (
      !main ||
      !from ||
      !to ||
      !contains(link.span, link.toSpan) ||
      (link.kind !== "wrapper" && !contains(link.span, link.fromSpan)) ||
      (link.kind === "wrapper" && link.fromSpan.file !== link.span.file)
    )
      return refuse(`link ${index} offsets escape cited declaration`);
    const text = decode(main),
      source = decode(from),
      destination = decode(to);
    if (text === null || source === null || destination === null)
      return refuse(`link ${index} has invalid UTF-8`);
    if (link.kind === "wrapper") {
      // An internal call precedes the wrapper declaration's external invocation.
      if (
        !identifier.test(destination) ||
        destination !== link.to ||
        !text.includes(destination) ||
        !source.includes(link.from.split(".").at(-1)!) ||
        !["function", "=>"].some((mark) => text.includes(mark)) ||
        index === 0 ||
        links[index - 1]!.kind !== "call" ||
        links[index - 1]!.span.file !== link.fromSpan.file ||
        links[index - 1]!.span.start !== link.fromSpan.start ||
        links[index - 1]!.span.end !== link.fromSpan.end
      )
        return refuse(`wrapper link ${index} has no cited declaration`);
    } else if (link.kind === "call") {
      if (
        source !== destination ||
        !dotted.test(source) ||
        !(source === link.from || source === `${link.from}.${link.to}`) ||
        !text.startsWith(source) ||
        !/^\s*\(/.test(text.slice(source.length)) ||
        !text.endsWith(")") ||
        source.split(".").at(-1) !== link.to
      )
        return refuse(`call link ${index} has no cited callee token`);
    } else {
      if (
        source !== link.from ||
        destination !== link.to ||
        !identifier.test(source) ||
        !identifier.test(destination)
      )
        return refuse(`link ${index} token names disagree`);
    }
    if (link.kind === "alias" && !text.includes("="))
      return refuse(`alias link ${index} has no assignment`);
    if (link.kind === "require" && !text.includes("require(") && !text.includes("require ("))
      return refuse(`require link ${index} has no loader invocation`);
    if (link.kind === "import" && !/^import\s/u.test(text))
      return refuse(`import link ${index} has no import declaration`);
    if (link.kind === "re-export" && !/^export\s/u.test(text))
      return refuse(`re-export link ${index} has no export declaration`);
    if (link.memberSpan) {
      const member = contains(link.span, link.memberSpan) && (await read(link.memberSpan));
      const memberText = member && decode(member);
      if (!memberText || !identifier.test(memberText) || !text.includes(memberText))
        return refuse(`link ${index} has invalid member citation`);
    }
    if (link.kind === "import" || link.kind === "require" || link.kind === "re-export") {
      if (!link.specifierSpan || !contains(link.span, link.specifierSpan))
        return refuse(`module link ${index} lacks contained specifier`);
      const specBytes = await read(link.specifierSpan);
      const specifier = specBytes && decode(specBytes);
      if (!specifier || !/^(["']).*\1$/s.test(specifier))
        return refuse(`module link ${index} lacks a quoted specifier`);
      const value = specifier.slice(1, -1);
      const relativeStart = link.specifierSpan.start - link.span.start;
      const relativeEnd = link.specifierSpan.end - link.span.start;
      const before = decode(main.subarray(0, relativeStart));
      const after = decode(main.subarray(relativeEnd));
      if (before === null || after === null)
        return refuse(`module link ${index} splits UTF-8 bytes`);
      if (
        link.kind === "require"
          ? !/\brequire\s*\(\s*$/u.test(before) || !/^\s*\)/u.test(after)
          : !/\bfrom\s*$/u.test(before) || !/^\s*;?\s*$/u.test(after)
      )
        return refuse(`module link ${index} specifier is not the declaration source`);
      if (index === 0 && value !== packageName)
        return refuse("package entry specifier disagrees with package");
      if (index > 0 && link.kind === "re-export" && !value.startsWith("."))
        return refuse(`barrel link ${index} has no relative specifier`);
    } else if (link.specifierSpan) return refuse(`non-module link ${index} has specifier`);
  }
  if (links.at(-1)!.to !== binding && links.at(-1)!.to !== binding.split(".").at(-1))
    return refuse("lineage terminal binding differs from call");
  return { status: "core-reconstructed" };
}
