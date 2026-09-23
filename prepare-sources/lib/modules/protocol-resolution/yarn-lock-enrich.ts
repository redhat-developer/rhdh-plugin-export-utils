import type { Lockfile, LockfileBlock } from "../../yarn-lock-parser.ts";
import { collectNpmDepReferences, findNpmBlocksForPackage } from "../../yarn-lock-helpers.ts";
import { caretOrTildeSatisfies } from "./semver-range.ts";

export function normalizeCombinedKeysForLocalPackage(
  lockfile: Lockfile,
  packageName: string,
  localPath: string,
): number {
  const workspaceOnly = `${packageName}@workspace:${localPath}`;
  let count = 0;

  for (const block of lockfile.blocks) {
    const hasWorkspacePath = block.descriptors.includes(workspaceOnly);
    if (!hasWorkspacePath || block.descriptors.length === 1) continue;

    const hasProtocolOrNpm = block.descriptors.some(
      (d) =>
        d !== workspaceOnly &&
        (d.includes("@workspace:^") ||
          d.includes("@workspace:*") ||
          d.includes("@backstage:^") ||
          d.includes("@npm:")),
    );
    if (hasProtocolOrNpm) {
      block.descriptors = [workspaceOnly];
      count++;
    }
  }

  return count;
}

export function enrichNpmBlockSpecifiers(
  lockfile: Lockfile,
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
  lockfile: Lockfile,
  packageName: string,
  ranges: Set<string>,
  npmBlocks: Array<{ block: LockfileBlock; version: string }>,
  log: (message: string) => void,
): number {
  let count = 0;

  for (const range of ranges) {
    const specifier = `${packageName}@npm:${range}`;
    if (lockfile.blocks.some((b) => b.descriptors.includes(specifier))) continue;

    const prefix: "^" | "~" = range.startsWith("~") ? "~" : "^";
    const rangeVersion = range.substring(1);
    const target = npmBlocks.find((b) => caretOrTildeSatisfies(b.version, prefix, rangeVersion));
    if (!target) {
      log(
        `yarn.lock: warning: no block for ${packageName} satisfies ${range} — skipping specifier enrichment`,
      );
      continue;
    }

    if (!target.block.descriptors.includes(specifier)) {
      target.block.descriptors.push(specifier);
      target.block.descriptors.sort((a, b) => a.localeCompare(b));
      count++;
    }
  }

  return count;
}
