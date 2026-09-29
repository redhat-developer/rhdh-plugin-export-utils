import fs from "node:fs";

/**
 * Filter that skips destination paths that already exist as files (compatible with `fs.cp` and `fs.cpSync`).
 *
 * @param src - Source path being considered for copy (unused).
 * @param dest - Destination path; skipped when it already exists as a file.
 * @returns `false` to skip an existing file, otherwise `true` to copy.
 */
export function skipExistingFile(src: string, dest: string): boolean {
  const stat = fs.statSync(dest, { throwIfNoEntry: false });
  return stat === undefined || !stat.isFile();
}
