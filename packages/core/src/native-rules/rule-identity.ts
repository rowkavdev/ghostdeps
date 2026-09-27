/** Deterministic identity of the rule fields that affect native policy. */
import { createHash } from "node:crypto";
import type { NativeRule } from "./index.js";

export const nativeRuleIdentity = (rule: NativeRule): string | null => {
  if (
    !rule ||
    typeof rule.id !== "string" ||
    typeof rule.ecosystem !== "string" ||
    typeof rule.nativeCapability !== "string" ||
    !Array.isArray(rule.packages) ||
    !Array.isArray(rule.coveredApis) ||
    !Array.isArray(rule.incompatibleUses) ||
    !Array.isArray(rule.semanticDifferences) ||
    !rule.minimumRuntime ||
    typeof rule.minimumRuntime !== "object" ||
    (rule.incompatiblePatternKinds !== undefined &&
      (typeof rule.incompatiblePatternKinds !== "object" ||
        Array.isArray(rule.incompatiblePatternKinds))) ||
    (rule.referenceSurface !== undefined &&
      (typeof rule.referenceSurface !== "object" || Array.isArray(rule.referenceSurface)))
  )
    return null;
  const strings = [
    rule.id,
    rule.ecosystem,
    rule.nativeCapability,
    ...rule.packages,
    ...rule.coveredApis,
    ...rule.incompatibleUses,
    ...rule.semanticDifferences,
  ];
  if (
    strings.some((value) => typeof value !== "string" || !value.trim()) ||
    Object.values(rule.minimumRuntime).some(
      (value) => typeof value !== "string" || !value.trim(),
    ) ||
    Object.values(rule.incompatiblePatternKinds ?? {}).some(
      (value) => !["member-call", "option-key-value", "property-chain"].includes(value),
    )
  )
    return null;
  const sorted = (values: readonly string[]) => [...values].sort();
  const ordered = (record: Readonly<Record<string, string>>) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  const value = JSON.stringify([
    rule.id,
    rule.ecosystem,
    rule.nativeCapability,
    sorted(rule.packages),
    ordered(rule.minimumRuntime),
    sorted(rule.coveredApis),
    sorted(rule.incompatibleUses),
    ordered(rule.incompatiblePatternKinds ?? {}),
    sorted(rule.semanticDifferences),
    rule.referenceSurface
      ? [
          rule.referenceSurface.cli,
          rule.referenceSurface.config,
          rule.referenceSurface.cliCitation ?? null,
          rule.referenceSurface.configCitation ?? null,
        ]
      : null,
  ]);
  return createHash("sha256").update("ghostdeps-native-rule-v1\0").update(value).digest("hex");
};
