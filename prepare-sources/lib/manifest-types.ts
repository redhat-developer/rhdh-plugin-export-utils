/**
 * Shape of `manifest.json` — inventory of all workspace packages.
 * Written by `generate-manifests`, consumed by `protocol-resolution`.
 */
export type WorkspaceManifest = {
  packages: WorkspacePackageEntry[];
};

export type WorkspacePackageEntry = {
  name: string;
  version: string;
  path?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, Record<string, unknown>>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: Record<string, string>;
};

/**
 * Shape of `backstage-manifest.json` — Backstage release packages with
 * dependency metadata. Written by `generate-manifests` (only when the
 * workspace has `backstage:^` deps), consumed by `protocol-resolution`.
 */
export type BackstageManifest = {
  backstageVersion: string;
  packages: BackstagePackageEntry[];
};

export type BackstagePackageEntry = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, Record<string, unknown>>;
  optionalDependencies?: Record<string, string>;
  bin?: Record<string, string>;
};
