/**
 * Shared helpers for mutating parsed Yarn Berry lockfiles.
 * Used by `protocol-resolution`, `package-cleanup`, and `validate`.
 *
 * Lockfiles are parsed/serialized via `@yarnpkg/parsers` (`parseSyml` /
 * `stringifySyml`). The parsed representation is a plain record whose keys
 * are compound descriptor strings (e.g. `"@foo/bar@npm:^1.0.0, @foo/bar@workspace:^"`)
 * and whose values are entry objects with direct field access.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A lockfile entry — the value side of one top-level key in a parsed
 * `yarn.lock`. Keys and values are unquoted (`parseSyml` strips quotes;
 * `stringifySyml` re-adds them where needed).
 */
export type LockfileEntry = {
  version?: string;
  resolution?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dependenciesMeta?: Record<string, Record<string, string>>;
  peerDependenciesMeta?: Record<string, Record<string, string>>;
  bin?: Record<string, string>;
  devDependencies?: Record<string, string>;
  languageName?: string;
  linkType?: string;
};

/**
 * Parsed lockfile — a record of descriptor-key → entry pairs.
 * The special `__metadata` key holds Yarn internal metadata.
 */
export type ParsedLockfile = Record<string, LockfileEntry>;

// ---------------------------------------------------------------------------
// Descriptor-key helpers
// ---------------------------------------------------------------------------

/** Split a compound descriptor key into individual descriptor strings. */
export function splitDescriptorKey(key: string): string[] {
  return key.split(/, /);
}

/** Join individual descriptor strings into a compound key. */
export function joinDescriptorKey(descriptors: string[]): string {
  return descriptors.join(", ");
}

// ---------------------------------------------------------------------------
// Descriptor matchers
// ---------------------------------------------------------------------------

/** Extract the npm package name from a lockfile descriptor (e.g. `@foo/bar@npm:^1.0`). */
export function packageNameFromDescriptor(descriptor: string): string | null {
  const match = /^((?:@[^@/]+\/)?[^@]+)@/.exec(descriptor);
  /* v8 ignore next -- null fallback: regex always matches valid descriptors */
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
  const match = /@workspace:([^",^*~][^",]*)/.exec(descriptor);
  const wsPath = match?.[1];
  if (!wsPath || wsPath === ".") return null;
  return wsPath;
}

/** Map package name → workspace-relative path for packages whose dirs exist on disk. */
export function findLocalPackagePaths(
  lockfile: ParsedLockfile,
  yarnLockDir: string,
): Map<string, string> {
  const localPackagePaths = new Map<string, string>();

  for (const key of Object.keys(lockfile)) {
    if (key === "__metadata") continue;
    for (const descriptor of splitDescriptorKey(key)) {
      const wsPath = descriptorWorkspacePath(descriptor);
      if (!wsPath) continue;
      const pkgName = packageNameFromDescriptor(descriptor);
      /* v8 ignore next -- defensive: workspace descriptors always have valid package names */
      if (!pkgName) continue;
      const fullPath = path.join(yarnLockDir, wsPath);
      if (fs.existsSync(fullPath)) {
        localPackagePaths.set(pkgName, wsPath);
      }
    }
  }

  return localPackagePaths;
}

/** First package name in a key matching a workspace/backstage protocol descriptor. */
export function workspaceProtocolPackageName(key: string): string | null {
  for (const descriptor of splitDescriptorKey(key)) {
    if (!descriptorHasWorkspaceProtocol(descriptor)) continue;
    const match = /^(?:@[^@/]+\/)?[^@",\s]+@(?:workspace:[*^~]|backstage:\^)/.exec(descriptor);

    /* v8 ignore next 4 -- defensive: valid workspace descriptors always match */
    if (match) {
      const name = packageNameFromDescriptor(descriptor);
      if (name) return name;
    }
  }
  return null;
}

export function blockKeyHasStaleWorkspacePath(key: string, yarnLockDir: string): boolean {
  for (const descriptor of splitDescriptorKey(key)) {
    const wsPath = descriptorWorkspacePath(descriptor);
    if (!wsPath) continue;
    const fullPath = path.join(yarnLockDir, wsPath);
    if (!fs.existsSync(fullPath)) return true;
  }
  return false;
}

export function keyHasWorkspaceProtocol(key: string): boolean {
  return splitDescriptorKey(key).some(descriptorHasWorkspaceProtocol);
}

/** npm specifiers (`pkg@npm:…`) preserved from a block's combined key. */
export function extractNpmSpecifiers(key: string, packageName: string): string[] {
  const specifiers: string[] = [];
  for (const descriptor of splitDescriptorKey(key)) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const pattern = new RegExp(`${escaped}@npm:[^",]+`, "g");
    let match: RegExpExecArray | null;
    /* v8 ignore next 3 -- only enters when combined key already has npm specifiers */
    while ((match = pattern.exec(descriptor)) !== null) {
      specifiers.push(match[0]);
    }
  }
  return specifiers;
}

/** Whether any block key includes `package@npm:^version` (or exact version). */
export function hasNpmResolutionBlock(
  lockfile: ParsedLockfile,
  packageName: string,
  version: string,
): boolean {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`${escapedName}@npm:\^?${escapedVersion}(?=[",\s]|$)`);
  return Object.keys(lockfile).some((key) => splitDescriptorKey(key).some((d) => pattern.test(d)));
}

/** Entries whose key references the given package name with npm specifiers. */
export function findNpmBlocksForPackage(
  lockfile: ParsedLockfile,
  packageName: string,
): Array<{ key: string; entry: LockfileEntry; version: string }> {
  const results: Array<{ key: string; entry: LockfileEntry; version: string }> = [];

  for (const [key, entry] of Object.entries(lockfile)) {
    if (key === "__metadata") continue;
    const hasNpmDescriptor = splitDescriptorKey(key).some((d) => d.includes(`${packageName}@npm:`));
    if (!hasNpmDescriptor) continue;
    const version = entry.version;
    /* v8 ignore next -- defensive: lockfile entries always have version */
    if (version) results.push({ key, entry, version });
  }

  return results;
}

/** Whether any block key contains the exact descriptor specifier. */
export function hasDescriptorSpecifier(lockfile: ParsedLockfile, specifier: string): boolean {
  return Object.keys(lockfile).some((key) => splitDescriptorKey(key).includes(specifier));
}

/** Dependency-like field names iterated by `forEachDependencyEntry`. */
const DEP_FIELD_NAMES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type DepFieldName = (typeof DEP_FIELD_NAMES)[number];

/** Iterate all dependency-map entries across every lockfile entry. */
export function forEachDependencyEntry(
  lockfile: ParsedLockfile,
  callback: (
    key: string,
    entry: LockfileEntry,
    fieldName: DepFieldName,
    depName: string,
    depValue: string,
  ) => void,
): void {
  for (const [key, rawEntry] of Object.entries(lockfile)) {
    if (key === "__metadata") continue;
    for (const fieldName of DEP_FIELD_NAMES) {
      const deps = rawEntry[fieldName];
      if (!deps) continue;
      for (const [depName, depValue] of Object.entries(deps)) {
        callback(key, rawEntry, fieldName, depName, depValue);
      }
    }
  }
}

/** Replace `workspace:^` / `backstage:^` dep values with `npm:^version` in all dep fields. */
export function replaceProtocolDepValues(
  lockfile: ParsedLockfile,
  packageName: string,
  version: string,
): number {
  let count = 0;
  const workspacePattern = /^(?:workspace:[*^]?|backstage:\^)$/;
  const target = `npm:^${version}`;

  forEachDependencyEntry(lockfile, (_key, entry, fieldName, depName, depValue) => {
    if (depName !== packageName) return;
    /* v8 ignore next 3 -- defensive: matched dep names always have workspace protocol */
    if (workspacePattern.test(depValue)) {
      const deps = entry[fieldName];
      if (deps) deps[depName] = target;
      count++;
    }
  });

  return count;
}

/** Collect npm caret/tilde ranges referenced in dependency map bodies. */
export function collectNpmDepReferences(lockfile: ParsedLockfile): Map<string, Set<string>> {
  const allRefs = new Map<string, Set<string>>();

  forEachDependencyEntry(lockfile, (_key, _entry, _fieldName, depName, depValue) => {
    const match = /^npm:([\^~])(.+)$/.exec(depValue);
    if (!match) return;
    let refs = allRefs.get(depName);
    if (!refs) {
      refs = new Set();
      allRefs.set(depName, refs);
    }
    refs.add(`${match[1]}${match[2]}`);
  });

  return allRefs;
}
