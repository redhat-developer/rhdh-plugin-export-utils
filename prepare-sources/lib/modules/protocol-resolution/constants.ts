/** Protocols used for workspace-internal references (excluded from type-shims stubs). */
export const INTERNAL_PROTOCOLS = ["workspace:", "backstage:"] as const;

/** Host dependencies required by frontend plugins (provided by app packages). */
export const HOST_DEPS = ["react", "react-dom", "react-router", "react-router-dom"] as const;

export const TYPE_SHIMS_NAME = "@internal/type-shims";
export const TYPE_SHIMS_DIR = "packages/type-shims";

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-dynamic",
  "build",
  "coverage",
]);

export const DEP_SECTIONS = [
  "resolutions",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Runtime packages whose @types/* are referenced via global-augments.d.ts. */
export const EXTRA_RUNTIME_TYPES = new Set(["compression"]);
