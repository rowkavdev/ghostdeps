import { readFileSync } from "node:fs";

/** Version from this package's package.json, with a safe fallback. */
export function cliVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const { version } = parsed;
      if (typeof version === "string") return version;
    }
  } catch {
    // Fall through to the default below.
  }
  return "0.0.0";
}
