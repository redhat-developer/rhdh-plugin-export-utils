import fs from "node:fs";

import * as z from "zod";

/**
 * Contents of a workspace's `source.json` file, which describes the upstream
 * repository that provides the plugin source code.
 */
export interface SourceJson {
  /** Repository URL (e.g. `https://github.com/org/repo`). */
  repo: string;
  /** Git ref to check out: a tag, branch, or commit SHA. */
  "repo-ref": string;
  /** Whether plugins live at the repository root rather than in a workspace subdirectory. */
  "repo-flat": boolean;
  /** Backstage version the source is compatible with. */
  "repo-backstage-version": string;
}

/** Zod schema for a workspace `source.json` file. */
export const sourceJsonSchema = z.strictObject({
  repo: z.string(),
  "repo-ref": z.string(),
  "repo-flat": z.boolean(),
  "repo-backstage-version": z.string(),
}) satisfies z.ZodType<SourceJson>;

/**
 * Read and validate a `source.json` file.
 *
 * @param filePath - Absolute path to the `source.json` file.
 * @throws If the file is missing, contains invalid JSON, or does not match
 *   {@link sourceJsonSchema}.
 */
export function readSourceFile(filePath: string): SourceJson {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Failed to load '${filePath}': file not found`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`Failed to load '${filePath}': invalid JSON`, { cause });
  }

  try {
    return sourceJsonSchema.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to load '${filePath}'`, { cause });
  }
}
