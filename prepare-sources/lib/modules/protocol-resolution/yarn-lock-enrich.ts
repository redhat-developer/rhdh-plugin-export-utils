import type { ParsedLockfile } from "../../yarn-lock-helpers.ts";
import {
  collectNpmDepReferences,
  findNpmBlocksForPackage,
  joinDescriptorKey,
  splitDescriptorKey,
} from "../../yarn-lock-helpers.ts";
import { caretOrTildeSatisfies } from "./semver-range.ts";

export function normalizeCombinedKeysForLocalPackage(
  lockfile: ParsedLockfile,
  packageName: string,
  localPath: string,
): number {
  const workspaceOnly = `${packageName}@workspace:${localPath}`;
  let count = 0;

  for (const key of Object.keys(lockfile)) {
    if (key === "__metadata") continue;
    const descriptors = splitDescriptorKey(key);
    const hasWorkspacePath = descriptors.includes(workspaceOnly);
    if (!hasWorkspacePath || descriptors.length === 1) continue;

    const hasProtocolOrNpm = descriptors.some(
      (d) =>
        d !== workspaceOnly &&
        (d.includes("@workspace:^") ||
          d.includes("@workspace:*") ||
          d.includes("@backstage:^") ||
          d.includes("@npm:")),
    );
    if (hasProtocolOrNpm) {
      /* v8 ignore next -- defensive: entry always exists since key came from Object.keys */
      const entry = lockfile[key] ?? {};
      delete lockfile[key];
      lockfile[workspaceOnly] = entry;
      count++;
    }
  }

  return count;
}

export function enrichNpmBlockSpecifiers(
  lockfile: ParsedLockfile,
  log: (message: string) => void,
): number {
  const allRefs = collectNpmDepReferences(lockfile);
  let enrichCount = 0;

  for (const [packageName, ranges] of allRefs) {
    const npmBlocks = findNpmBlocksForPackage(lockfile, packageName);
    if (npmBlocks.length === 0) {
      log(`yarn.lock: warning: no npm block found for ${packageName} — cannot enrich specifiers`);
      continue;
    }
    enrichCount += enrichRangesForPackage(lockfile, packageName, ranges, npmBlocks, log);
  }

  return enrichCount;
}

function enrichRangesForPackage(
  lockfile: ParsedLockfile,
  packageName: string,
  ranges: Set<string>,
  npmBlocks: Array<{ key: string; version: string }>,
  log: (message: string) => void,
): number {
  let count = 0;

  for (const range of ranges) {
    const specifier = `${packageName}@npm:${range}`;
    const alreadyExists = Object.keys(lockfile).some((k) =>
      splitDescriptorKey(k).includes(specifier),
    );
    if (alreadyExists) continue;

    const prefix: "^" | "~" = range.startsWith("~") ? "~" : "^";
    const rangeVersion = range.substring(1);
    const target = npmBlocks.find((b) => caretOrTildeSatisfies(b.version, prefix, rangeVersion));
    if (!target) {
      log(
        `yarn.lock: warning: no block for ${packageName} satisfies ${range} — skipping specifier enrichment`,
      );
      continue;
    }

    const oldDescriptors = splitDescriptorKey(target.key);
    const newDescriptors = [...oldDescriptors, specifier].toSorted((a, b) => a.localeCompare(b));
    const newKey = joinDescriptorKey(newDescriptors);
    /* v8 ignore next -- defensive: entry always exists since target.key came from lockfile */
    const entry = lockfile[target.key] ?? {};
    delete lockfile[target.key];
    lockfile[newKey] = entry;
    target.key = newKey;
    count++;
  }

  return count;
}
