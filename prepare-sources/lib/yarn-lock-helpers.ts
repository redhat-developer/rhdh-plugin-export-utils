/**
 * Shared helpers for mutating parsed Yarn Berry lockfiles.
 * Used by `protocol-resolution`, `package-cleanup`, and `validate`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Lockfile, LockfileBlock, MapField } from "./yarn-lock-parser.ts";
import { getScalar } from "./yarn-lock-parser.ts";

/** Strip surrounding quotes from a yarn.lock scalar or map value. */
export function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

/** Extract the npm package name from a lockfile descriptor (e.g. `@foo/bar@npm:^1.0`). */
export function packageNameFromDescriptor(descriptor: string): string | null {
  const match = /^((?:@[^@/]+\/)?[^@]+)@/.exec(descriptor);
  return match?.[1] ?? null;
}

export function descriptorHasWorkspaceProtocol(descriptor: string): boolean {
  return (
    descriptor.includes("@workspace:^") ||
    descriptor.includes("@workspace:*") ||
    descriptor.includes("@workspace:~") ||
    descriptor.includes("@backstage:^")
  );
}

/** Relative workspace path from a `package@workspace:path` descriptor, or null. */
export function descriptorWorkspacePath(descriptor: string): string | null {
  const match = /@workspace:([^",^*][^",]*)/.exec(descriptor);
  const wsPath = match?.[1];
  if (!wsPath || wsPath === ".") return null;
  return wsPath;
}

/** Map package name → workspace-relative path for packages whose dirs exist on disk. */
export function findLocalPackagePaths(
  lockfile: Lockfile,
  yarnLockDir: string,
): Map<string, string> {
  const localPackagePaths = new Map<string, string>();

  for (const block of lockfile.blocks) {
    for (const descriptor of block.descriptors) {
      const wsPath = descriptorWorkspacePath(descriptor);
      if (!wsPath) continue;
      const pkgName = packageNameFromDescriptor(descriptor);
      if (!pkgName) continue;
      const fullPath = path.join(yarnLockDir, wsPath);
      if (fs.existsSync(fullPath)) {
        localPackagePaths.set(pkgName, wsPath);
      }
    }
  }

  return localPackagePaths;
}

/** First package name in a block matching a workspace/backstage protocol descriptor. */
export function workspaceProtocolPackageName(block: LockfileBlock): string | null {
  for (const descriptor of block.descriptors) {
    if (!descriptorHasWorkspaceProtocol(descriptor)) continue;
    const match = /^(?:@[^@/]+\/)?[^@",\s]+@(?:workspace:[*^~]|backstage:\^)/.exec(descriptor);

    if (match) {
      const name = packageNameFromDescriptor(descriptor);
      if (name) return name;
    }
  }
  return null;
}

export function blockHasStaleWorkspacePath(block: LockfileBlock, yarnLockDir: string): boolean {
  for (const descriptor of block.descriptors) {
    const wsPath = descriptorWorkspacePath(descriptor);
    if (!wsPath) continue;
    const fullPath = path.join(yarnLockDir, wsPath);
    if (!fs.existsSync(fullPath)) return true;
  }
  return false;
}

export function blockHasWorkspaceProtocol(block: LockfileBlock): boolean {
  return block.descriptors.some(descriptorHasWorkspaceProtocol);
}

/** npm specifiers (`pkg@npm:…`) preserved from a block's combined key. */
export function extractNpmSpecifiers(block: LockfileBlock, packageName: string): string[] {
  const specifiers: string[] = [];
  for (const descriptor of block.descriptors) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const pattern = new RegExp(`${escaped}@npm:[^",]+`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(descriptor)) !== null) {
      specifiers.push(match[0]);
    }
  }
  return specifiers;
}

/** Whether any block key includes `package@npm:^version` (or exact version). */
export function hasNpmResolutionBlock(
  lockfile: Lockfile,
  packageName: string,
  version: string,
): boolean {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`${escapedName}@npm:\^?${escapedVersion}(?=[",])`);
  return lockfile.blocks.some((block) => block.descriptors.some((d) => pattern.test(d)));
}

/** Whether any block descriptor includes `package@npm:range` (range includes ^ or ~). */
export function hasNpmSpecifierBlock(
  lockfile: Lockfile,
  packageName: string,
  range: string,
): boolean {
  const specifier = `${packageName}@npm:${range}`;
  return lockfile.blocks.some((block) => block.descriptors.some((d) => d.includes(specifier)));
}

/** Blocks whose descriptors reference the given package name with npm specifiers. */
export function findNpmBlocksForPackage(
  lockfile: Lockfile,
  packageName: string,
): Array<{ block: LockfileBlock; version: string }> {
  const results: Array<{ block: LockfileBlock; version: string }> = [];

  for (const block of lockfile.blocks) {
    const hasNpmDescriptor = block.descriptors.some((d) => d.includes(`${packageName}@npm:`));
    if (!hasNpmDescriptor) continue;
    const version = getScalar(block, "version");
    if (version) results.push({ block, version });
  }

  return results;
}

/** Whether a block key already contains the exact descriptor specifier. */
export function hasDescriptorSpecifier(lockfile: Lockfile, specifier: string): boolean {
  return lockfile.blocks.some((block) => block.descriptors.includes(specifier));
}

/** Iterate all dependency-map entries across every block. */
export function forEachDependencyEntry(
  lockfile: Lockfile,
  callback: (block: LockfileBlock, mapField: MapField, depName: string, rawValue: string) => void,
): void {
  for (const block of lockfile.blocks) {
    for (const field of Object.values(block.fields)) {
      if (field.kind !== "map") continue;
      for (const [depName, rawValue] of Object.entries(field.entries)) {
        callback(block, field, depName, rawValue);
      }
    }
  }
}

/** Replace `workspace:^` / `backstage:^` dep values with `npm:^version` in all map fields. */
export function replaceProtocolDepValues(
  lockfile: Lockfile,
  packageName: string,
  version: string,
): number {
  let count = 0;
  const workspacePattern = /^(?:workspace:[*^]?|backstage:\^)$/;
  const target = `"npm:^${version}"`;

  forEachDependencyEntry(lockfile, (_block, mapField, depName, rawValue) => {
    if (depName !== `"${packageName}"` && depName !== packageName) return;
    const unquoted = unquote(rawValue);
    if (workspacePattern.test(unquoted)) {
      mapField.entries[depName] = target;
      count++;
    }
  });

  return count;
}

/** Collect npm caret/tilde ranges referenced in dependency map bodies. */
export function collectNpmDepReferences(lockfile: Lockfile): Map<string, Set<string>> {
  const allRefs = new Map<string, Set<string>>();

  forEachDependencyEntry(lockfile, (_block, _mapField, depName, rawValue) => {
    const name = unquote(depName);
    const unquoted = unquote(rawValue);
    const match = /^npm:([\^~])(.+)$/.exec(unquoted);
    if (!match) return;
    let refs = allRefs.get(name);
    if (!refs) {
      refs = new Set();
      allRefs.set(name, refs);
    }
    refs.add(`${match[1]}${match[2]}`);
  });

  return allRefs;
}

/** Build a sorted map field from lockfile-formatted `"key": "value"` entries. */
export function buildMapField(entries: Record<string, string>): MapField {
  const sorted: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries).toSorted((a, b) => a[0].localeCompare(b[0]))) {
    sorted[key] = value;
  }
  return { kind: "map", entries: sorted };
}

export function blockLinkType(block: LockfileBlock): string | undefined {
  return getScalar(block, "linkType");
}
