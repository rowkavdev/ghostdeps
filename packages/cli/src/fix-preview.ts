import { previewNpmRemoval, FsRepositoryHandle } from "@ghostdeps/core";
import { defaultAdapters } from "./adapters.js";
import type { CliConfig } from "./config.js";
import type { Io } from "./cli.js";
import { EXIT_ERROR, EXIT_OK } from "./errors.js";

/** Explicit dry-run, offline and read-only. A refusal is never an empty success. */
export async function runFixPreview(config: CliConfig, io: Io): Promise<number> {
  const handle = await FsRepositoryHandle.open(config.path);
  const preview = await previewNpmRemoval(handle, defaultAdapters(), config.packageName!);
  if (config.json) {
    io.stdout(JSON.stringify(preview, null, 2));
  } else if (preview.status === "blocked") {
    io.stdout(`Fix preview refused: ${preview.reason}\nNo files changed.`);
  } else {
    io.stdout(
      `Fix preview ${preview.key}\nStatus: statically checked, not applied.\n` +
        `Static: passed; lockfile: passed; sandbox: not run.\n` +
        `Files: ${preview.files!.map((f) => `${f.path} (${f.beforeSha256} -> ${f.afterSha256})`).join(", ")}\n` +
        `${preview.diff}No files changed.`,
    );
  }
  return preview.status === "blocked" ? EXIT_ERROR : EXIT_OK;
}
