import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { BackstageManifest, WorkspaceManifest } from "../../manifest-types.ts";
import type { ParsedLockfile } from "../../yarn-lock-helpers.ts";
import { mockFetch, testInputOutputExpectations } from "../../test-utils.ts";
import { clearNpmMetadataCache, fetchNpmPackageMetadata } from "./npm-metadata.ts";
import { caretOrTildeSatisfies } from "./semver-range.ts";
import {
  extractPackageNameFromSpecifier,
  findPackageJsonFiles,
  findPackageVersion,
} from "./utils.ts";
import { typesPackageToRuntime, extractPackageName, isNeededDevDep } from "./type-shims.ts";
import { buildVersionMap } from "./version-map.ts";
import {
  normalizeCombinedKeysForLocalPackage,
  enrichNpmBlockSpecifiers,
} from "./yarn-lock-enrich.ts";
import {
  buildDependenciesField,
  buildResolutionEntry,
  buildWorkspaceSoftEntry,
  mergeOptionalIntoDependencies,
  fetchNpmMetadataForBlock,
  getDependenciesFromManifests,
} from "./yarn-lock-metadata.ts";
import type { PackageLockMetadata } from "./yarn-lock-metadata.ts";
import { run } from "./index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  clearNpmMetadataCache();
});

/**
 * Fixture catalog (`__fixtures__/<name>/` — name doubles as the Vitest case title):
 *
 * - `preserve-local-workspace-ref` — `workspace:^` kept for surviving local packages;
 *   scrubbed `@backstage/config` resolved to `^1.5.0` in package.json and yarn.lock
 * - `resolve-scrubbed-backstage-dep` — `backstage:^` → npm semver ranges; dangling
 *   resolution blocks created for scrubbed Backstage packages
 * - `resolves-dangling-dep-reference` — dep body references a specifier with no block;
 *   a new hard npm block is created to satisfy it.
 * - `enriches-npm-block-specifiers` — npm block keys gain missing specifiers referenced
 *   by other blocks' dependency maps (e.g. `ms@npm:^2.1.3` added alongside `^2.1.0`)
 * - `resolves-peer-and-dev-protocol-refs` — `workspace:^` in peerDependencies and
 *   devDependencies resolved to npm ranges
 * - `creates-combined-key-for-local-with-npm-refs` — surviving local package gets a
 *   separate hard npm resolution block; soft workspace block keeps workspace-only key
 * - `creates-hard-npm-blocks-for-local-packages` — comprehensive local+scrubbed scenario:
 *   soft workspace blocks preserved, hard npm blocks created for all local and scrubbed
 *   packages, dangling deps (e.g. @backstage/types) resolved transitively
 * - `resolves-scrubbed-workspace-dep-in-lockfile` — scrubbed `workspace:^` block
 *   replaced with npm resolution block; surviving local `workspace:^` preserved
 * - `creates-type-shims-from-scrubbed-app` — scrubbed `packages/app` in manifest (dir
 *   absent) triggers `@internal/type-shims` for frontend plugin imports
 * - `deletes-stale-workspace-path-lockfile-blocks` — `workspace:packages/app` blocks
 *   removed when the path no longer exists on disk
 * - `removes-stale-unresolvable-dependency` — `@gone/missing: workspace:^` dropped from
 *   package.json when not in version map and not on disk; yarn.lock dep-map entry
 *   intentionally kept (lockfile dep cleanup is handled by a later pipeline stage)
 * - `noop-when-no-protocol-refs` — workspace with only npm deps; no output/ changes
 * - `skips-type-shims-when-not-needed` — protocol resolution without scrubbed app/types
 *   need; no type-shims package created
 * - `throws-when-manifest-missing` — error when `manifest.json` absent
 * - `throws-when-yarn-lock-missing` — error when `yarn.lock` absent
 */
describe("protocol-resolution", () => {
  testInputOutputExpectations(import.meta.dirname, run, {
    setup: (fixture, fixtureDir) => {
      const npmResponsesDir = path.join(fixtureDir, "npm-responses");
      if (!fs.existsSync(npmResponsesDir)) return;

      const mappings: Record<string, object> = {};
      for (const file of fs.readdirSync(npmResponsesDir)) {
        if (!file.endsWith(".json")) continue;
        const [pkg = "", version = ""] = file.replace(".json", "").split("@");
        const scoped = pkg.includes("__") ? pkg.replace("__", "/") : pkg;
        const packageName = scoped;
        const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
        mappings[url] = JSON.parse(fs.readFileSync(path.join(npmResponsesDir, file), "utf8"));
      }
      if (Object.keys(mappings).length > 0) mockFetch(mappings);
    },
  });

  it("buildVersionMap skips packages missing name or version", () => {
    const map = buildVersionMap(
      {
        packages: [
          { name: "", version: "1.0.0" },
          { name: "@good/pkg", version: "2.0.0" },
          { name: "@noversion/pkg", version: "" },
        ],
      },
      null,
    );
    expect(map.size).toBe(1);
    expect(map.get("@good/pkg")).toBe("2.0.0");
  });

  it("buildVersionMap merges workspace and backstage manifests", () => {
    const map = buildVersionMap(
      {
        packages: [
          { name: "@local/pkg", version: "1.0.0" },
          { name: "@shared/pkg", version: "2.0.0" },
        ],
      },
      {
        backstageVersion: "1.42.0",
        packages: [{ name: "@backstage/core", version: "1.42.0" }],
      },
    );
    expect(map.get("@local/pkg")).toBe("1.0.0");
    expect(map.get("@backstage/core")).toBe("1.42.0");
  });

  it("caretOrTildeSatisfies handles caret ranges", () => {
    expect(caretOrTildeSatisfies("1.2.5", "^", "1.2.0")).toBe(true);
    expect(caretOrTildeSatisfies("1.3.0", "^", "1.2.0")).toBe(true);
    expect(caretOrTildeSatisfies("2.0.0", "^", "1.2.0")).toBe(false);
    expect(caretOrTildeSatisfies("1.2", "^", "1.2.0")).toBe(false);
  });

  describe("caretOrTildeSatisfies — tilde and ^0.x", () => {
    it("tilde: same major.minor, patch >=", () => {
      expect(caretOrTildeSatisfies("1.2.5", "~", "1.2.0")).toBe(true);
      expect(caretOrTildeSatisfies("1.2.0", "~", "1.2.0")).toBe(true);
    });
    it("tilde: different minor rejected", () => {
      expect(caretOrTildeSatisfies("1.3.0", "~", "1.2.0")).toBe(false);
    });
    it("caret 0.x: same 0.minor, patch >=", () => {
      expect(caretOrTildeSatisfies("0.2.1", "^", "0.2.0")).toBe(true);
      expect(caretOrTildeSatisfies("0.2.0", "^", "0.2.0")).toBe(true);
    });
    it("caret 0.x: different 0.minor rejected", () => {
      expect(caretOrTildeSatisfies("0.3.0", "^", "0.2.0")).toBe(false);
    });
    it("caret 0.0.x: exact patch only", () => {
      expect(caretOrTildeSatisfies("0.0.3", "^", "0.0.3")).toBe(true);
      expect(caretOrTildeSatisfies("0.0.4", "^", "0.0.3")).toBe(false);
    });
  });

  describe("npm-metadata fetch", () => {
    const log = vi.fn();

    it("returns cached result on second call", async () => {
      mockFetch({
        "https://registry.npmjs.org/cached-pkg/1.0.0": { name: "cached-pkg", version: "1.0.0" },
      });
      const first = await fetchNpmPackageMetadata("cached-pkg", "1.0.0", log);
      expect(first).toEqual({ name: "cached-pkg", version: "1.0.0" });

      vi.restoreAllMocks();
      const second = await fetchNpmPackageMetadata("cached-pkg", "1.0.0", log);
      expect(second).toEqual({ name: "cached-pkg", version: "1.0.0" });
    });

    it("retries on transient 503, succeeds on second attempt", async () => {
      let attempt = 0;
      vi.stubGlobal("fetch", async () => {
        attempt++;
        if (attempt === 1) {
          return new Response("", { status: 503 });
        }
        return new Response(JSON.stringify({ name: "retry-pkg" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const result = await fetchNpmPackageMetadata("retry-pkg", "1.0.0", log);
      expect(result).toEqual({ name: "retry-pkg" });
      expect(attempt).toBe(2);
    });

    it("returns null on permanent 403", async () => {
      mockFetch({
        "https://registry.npmjs.org/forbidden-pkg/1.0.0": {
          body: {},
          status: 403,
        },
      });
      const result = await fetchNpmPackageMetadata("forbidden-pkg", "1.0.0", log);
      expect(result).toBeNull();
    });

    it("returns cached null on second call after permanent failure", async () => {
      mockFetch({
        "https://registry.npmjs.org/cached-null-pkg/1.0.0": {
          body: {},
          status: 403,
        },
      });
      const first = await fetchNpmPackageMetadata("cached-null-pkg", "1.0.0", log);
      expect(first).toBeNull();

      vi.restoreAllMocks();
      const second = await fetchNpmPackageMetadata("cached-null-pkg", "1.0.0", log);
      expect(second).toBeNull();
    });

    it("returns null on error body", async () => {
      mockFetch({
        "https://registry.npmjs.org/err-body-pkg/1.0.0": { error: "not found" },
      });
      const result = await fetchNpmPackageMetadata("err-body-pkg", "1.0.0", log);
      expect(result).toBeNull();
    });

    it("retries on network error, succeeds on second attempt", async () => {
      let attempt = 0;
      vi.stubGlobal("fetch", async () => {
        attempt++;
        if (attempt === 1) throw new Error("ECONNRESET");
        return new Response(JSON.stringify({ name: "net-retry-pkg" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const result = await fetchNpmPackageMetadata("net-retry-pkg", "1.0.0", log);
      expect(result).toEqual({ name: "net-retry-pkg" });
      expect(attempt).toBe(2);
    });

    it("returns null after all retries exhausted", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("ECONNREFUSED");
      });
      const result = await fetchNpmPackageMetadata("fail-pkg", "1.0.0", log);
      expect(result).toBeNull();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("could not fetch npm metadata for fail-pkg@1.0.0"),
      );
    });

    it("returns null on 429 after all retries exhausted", async () => {
      vi.stubGlobal("fetch", async () => new Response("", { status: 429 }));
      const result = await fetchNpmPackageMetadata("throttle-pkg", "1.0.0", log);
      expect(result).toBeNull();
    });
  });

  describe("utils edge cases", () => {
    it("extractPackageNameFromSpecifier returns null for empty string", () => {
      expect(extractPackageNameFromSpecifier("")).toBeNull();
    });

    it("extractPackageNameFromSpecifier returns null for just @", () => {
      expect(extractPackageNameFromSpecifier("@")).toBeNull();
    });

    it("extractPackageNameFromSpecifier extracts scoped name", () => {
      expect(extractPackageNameFromSpecifier("@foo/bar@npm:^1.0.0")).toBe("@foo/bar");
    });

    it("extractPackageNameFromSpecifier extracts unscoped name", () => {
      expect(extractPackageNameFromSpecifier("lodash@npm:^4.0.0")).toBe("lodash");
    });

    it("findPackageJsonFiles handles non-existent dir gracefully", () => {
      expect(findPackageJsonFiles("/tmp/nonexistent-dir-xyz-12345")).toEqual([]);
    });

    it("findPackageVersion returns null for unknown package", () => {
      const tmpDir = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
      try {
        expect(findPackageVersion("@nonexistent/pkg", tmpDir)).toBeNull();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("buildDependenciesField", () => {
    it("sorts entries alphabetically and adds npm: prefix", () => {
      const { field, emittedKeys } = buildDependenciesField(
        { "z-pkg": "^2.0.0", "a-pkg": "^1.0.0" },
        null,
      );
      expect(field).not.toBeNull();
      expect(Object.keys(field ?? {})).toEqual(["a-pkg", "z-pkg"]);
      expect(field).toEqual({ "a-pkg": "npm:^1.0.0", "z-pkg": "npm:^2.0.0" });
      expect(emittedKeys).toEqual(new Set(["a-pkg", "z-pkg"]));
    });

    it("skips unresolved workspace: and backstage:^ deps", () => {
      const { field, emittedKeys } = buildDependenciesField(
        { "a-pkg": "workspace:^", "b-pkg": "backstage:^", "c-pkg": "^1.0.0" },
        null,
      );
      expect(field).toEqual({ "c-pkg": "npm:^1.0.0" });
      expect(emittedKeys).toEqual(new Set(["c-pkg"]));
    });

    it("passes through deps already prefixed with npm:", () => {
      const { field } = buildDependenciesField({ "some-pkg": "npm:^3.0.0" }, null);
      expect(field).toEqual({ "some-pkg": "npm:^3.0.0" });
    });

    it("returns null field when all deps are skipped", () => {
      const { field, emittedKeys } = buildDependenciesField({ "a-pkg": "workspace:^" }, null);
      expect(field).toBeNull();
      expect(emittedKeys.size).toBe(0);
    });
  });

  describe("buildResolutionEntry", () => {
    it("sorts ≥2 descriptors in the key", () => {
      const { key, entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0", "my-pkg@npm:^0.9.0"],
        { dependencies: null, peerDependencies: null, bin: null },
        null,
      );
      expect(key).toContain("my-pkg@npm:^0.9.0");
      expect(key.indexOf("^0.9.0")).toBeLessThan(key.indexOf("^1.0.0"));
      expect(entry.version).toBe("1.0.0");
      expect(entry.linkType).toBe("hard");
    });

    it("populates ≥2 peer deps with sorting", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: { "z-peer": "^2.0.0", "a-peer": "^1.0.0" },
          bin: null,
        },
        null,
      );
      expect(Object.keys(entry.peerDependencies ?? {})).toEqual(["a-peer", "z-peer"]);
    });

    it("populates ≥2 dependenciesMeta with sorting and stringifyMetaValue string branch", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: { "opt-a": "^1.0.0", "opt-b": "^2.0.0" },
          dependenciesMeta: {
            "opt-b": { optional: "true" },
            "opt-a": { optional: true },
          },
          peerDependencies: null,
          bin: null,
        },
        null,
      );
      expect(Object.keys(entry.dependenciesMeta ?? {})).toEqual(["opt-a", "opt-b"]);
      expect(entry.dependenciesMeta?.["opt-a"]).toEqual({ optional: "true" });
      expect(entry.dependenciesMeta?.["opt-b"]).toEqual({ optional: "true" });
    });

    it("populates ≥2 peerDependenciesMeta with sorting", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: { "z-peer": "^2.0.0", "a-peer": "^1.0.0" },
          peerDependenciesMeta: {
            "z-peer": { optional: true },
            "a-peer": { optional: true },
          },
          bin: null,
        },
        null,
      );
      expect(Object.keys(entry.peerDependenciesMeta ?? {})).toEqual(["a-peer", "z-peer"]);
    });

    it("populates bin from string (unscoped name as key)", () => {
      const { entry } = buildResolutionEntry(
        "@scope/my-cli",
        "1.0.0",
        ["@scope/my-cli@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: null,
          bin: "./bin/cli.js",
        },
        null,
      );
      expect(entry.bin).toEqual({ "my-cli": "./bin/cli.js" });
    });

    it("populates bin from object", () => {
      const { entry } = buildResolutionEntry(
        "my-tool",
        "2.0.0",
        ["my-tool@npm:^2.0.0"],
        {
          dependencies: null,
          peerDependencies: null,
          bin: { "my-tool": "./bin/tool.js", mt: "./bin/mt.js" },
        },
        null,
      );
      expect(entry.bin).toEqual({ "my-tool": "./bin/tool.js", mt: "./bin/mt.js" });
    });

    it("omits bin when bin object is empty", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: null,
          bin: {},
        },
        null,
      );
      expect(entry.bin).toBeUndefined();
    });

    it("passes depsMeta through filterDepsMeta when no emittedDepKeys (no deps)", () => {
      const { entry } = buildResolutionEntry(
        "meta-only",
        "1.0.0",
        ["meta-only@npm:^1.0.0"],
        {
          dependencies: null,
          dependenciesMeta: { "some-dep": { optional: true } },
          peerDependencies: null,
          bin: null,
        },
        null,
      );
      expect(entry.dependenciesMeta).toEqual({ "some-dep": { optional: "true" } });
    });

    it("omits dependenciesMeta when all depsMeta entries are filtered out", () => {
      const { entry } = buildResolutionEntry(
        "filtered-pkg",
        "1.0.0",
        ["filtered-pkg@npm:^1.0.0"],
        {
          dependencies: { "kept-dep": "^1.0.0" },
          dependenciesMeta: { "removed-dep": { optional: true } },
          peerDependencies: null,
          bin: null,
        },
        null,
      );
      expect(entry.dependenciesMeta).toBeUndefined();
    });

    it("filterDepsMeta removes non-emitted keys", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: { "kept-dep": "^1.0.0", "skipped-dep": "workspace:^" },
          dependenciesMeta: {
            "kept-dep": { optional: true },
            "skipped-dep": { optional: true },
          },
          peerDependencies: null,
          bin: null,
        },
        null,
      );
      expect(entry.dependenciesMeta).toEqual({ "kept-dep": { optional: "true" } });
    });

    it("omits peerDependencies when peerDeps record is empty", () => {
      const { entry } = buildResolutionEntry(
        "my-pkg",
        "1.0.0",
        ["my-pkg@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: {},
          peerDependenciesMeta: {},
          bin: null,
        },
        null,
      );
      expect(entry.peerDependencies).toBeUndefined();
      expect(entry.peerDependenciesMeta).toBeUndefined();
    });

    it("omits fields when metadata has no deps/peers/bin", () => {
      const { entry } = buildResolutionEntry(
        "bare-pkg",
        "1.0.0",
        ["bare-pkg@npm:^1.0.0"],
        {
          dependencies: null,
          peerDependencies: null,
          bin: null,
        },
        null,
      );
      expect(entry.dependencies).toBeUndefined();
      expect(entry.peerDependencies).toBeUndefined();
      expect(entry.dependenciesMeta).toBeUndefined();
      expect(entry.peerDependenciesMeta).toBeUndefined();
      expect(entry.bin).toBeUndefined();
    });
  });

  describe("buildWorkspaceSoftEntry", () => {
    it("sorts deps and devDeps alphabetically with npm: prefix", () => {
      const { key, entry } = buildWorkspaceSoftEntry(
        "@internal/shim",
        "packages/shim",
        { "z-dep": "^2.0.0", "a-dep": "^1.0.0" },
        { "z-dev": "^3.0.0", "a-dev": "^0.5.0" },
      );
      expect(key).toBe("@internal/shim@workspace:packages/shim");
      expect(entry.version).toBe("0.0.0-use.local");
      expect(entry.linkType).toBe("soft");
      expect(Object.keys(entry.dependencies ?? {})).toEqual(["a-dep", "z-dep"]);
      expect(Object.keys(entry.devDependencies ?? {})).toEqual(["a-dev", "z-dev"]);
    });

    it("passes through deps and devDeps already prefixed with npm:", () => {
      const { entry } = buildWorkspaceSoftEntry(
        "@internal/shim",
        "packages/shim",
        { "pre-npm": "npm:^1.0.0" },
        { "dev-pre-npm": "npm:^2.0.0" },
      );
      expect(entry.dependencies).toEqual({ "pre-npm": "npm:^1.0.0" });
      expect(entry.devDependencies).toEqual({ "dev-pre-npm": "npm:^2.0.0" });
    });

    it("omits deps/devDeps when empty", () => {
      const { entry } = buildWorkspaceSoftEntry("@internal/shim", "packages/shim", {}, {});
      expect(entry.dependencies).toBeUndefined();
      expect(entry.devDependencies).toBeUndefined();
    });
  });

  describe("mergeOptionalIntoDependencies", () => {
    it("initializes null dependencies and dependenciesMeta before merging", () => {
      const metadata: PackageLockMetadata = {
        dependencies: null,
        dependenciesMeta: null,
        optionalDependencies: { "opt-pkg": "^1.0.0" },
      };
      mergeOptionalIntoDependencies(metadata);
      expect(metadata.dependencies).toEqual({ "opt-pkg": "^1.0.0" });
      expect(metadata.dependenciesMeta).toEqual({ "opt-pkg": { optional: true } });
      expect(metadata.optionalDependencies).toBeUndefined();
    });

    it("merges into existing dependencies and dependenciesMeta", () => {
      const metadata: PackageLockMetadata = {
        dependencies: { "existing-dep": "^2.0.0" },
        dependenciesMeta: { "existing-dep": { optional: false } },
        optionalDependencies: { "opt-pkg": "^1.0.0" },
      };
      mergeOptionalIntoDependencies(metadata);
      expect(metadata.dependencies).toEqual({
        "existing-dep": "^2.0.0",
        "opt-pkg": "^1.0.0",
      });
      expect(metadata.dependenciesMeta).toEqual({
        "existing-dep": { optional: false },
        "opt-pkg": { optional: true },
      });
    });
  });

  describe("typesPackageToRuntime", () => {
    it("returns null for non-@types package", () => {
      expect(typesPackageToRuntime("lodash")).toBeNull();
    });

    it("converts unscoped @types to bare name", () => {
      expect(typesPackageToRuntime("@types/lodash")).toBe("lodash");
    });

    it("converts scoped @types/scope__pkg to @scope/pkg", () => {
      expect(typesPackageToRuntime("@types/babel__core")).toBe("@babel/core");
    });

    it("handles double-underscore with multiple segments", () => {
      expect(typesPackageToRuntime("@types/scope__a__b")).toBe("@scope/a__b");
    });
  });

  describe("extractPackageName", () => {
    it("extracts scoped package name", () => {
      expect(extractPackageName("@foo/bar")).toBe("@foo/bar");
    });

    it("extracts scoped package name from import with subpath", () => {
      expect(extractPackageName("@foo/bar/baz")).toBe("@foo/bar");
    });

    it("returns null for bare @ with no scope/name", () => {
      expect(extractPackageName("@")).toBeNull();
    });

    it("extracts unscoped package name", () => {
      expect(extractPackageName("lodash")).toBe("lodash");
    });

    it("extracts unscoped package name with subpath", () => {
      expect(extractPackageName("lodash/fp")).toBe("lodash");
    });

    it("returns null for relative paths", () => {
      expect(extractPackageName("./local")).toBeNull();
      expect(extractPackageName("../parent")).toBeNull();
    });

    it("returns null for absolute paths", () => {
      expect(extractPackageName("/absolute")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractPackageName("")).toBeNull();
    });
  });

  describe("isNeededDevDep", () => {
    it("returns false for internal protocol deps", () => {
      expect(isNeededDevDep("pkg", "workspace:^", [], new Set())).toBe(false);
    });

    it("returns false when already provided", () => {
      expect(isNeededDevDep("pkg", "^1.0.0", [], new Set(["pkg"]))).toBe(false);
    });

    it("returns true when name is in a runtime set", () => {
      expect(isNeededDevDep("pkg", "^1.0.0", [new Set(["pkg"])], new Set())).toBe(true);
    });

    it("returns true for @types/ when runtime package is in a runtime set", () => {
      expect(isNeededDevDep("@types/lodash", "^4.0.0", [new Set(["lodash"])], new Set())).toBe(
        true,
      );
    });

    it("returns false for @types/ when runtime package is not in any set", () => {
      expect(isNeededDevDep("@types/lodash", "^4.0.0", [new Set()], new Set())).toBe(false);
    });

    it("returns false for non-@types dep not in any runtime set", () => {
      expect(isNeededDevDep("unused-pkg", "^1.0.0", [new Set(["other"])], new Set())).toBe(false);
    });
  });

  describe("normalizeCombinedKeysForLocalPackage", () => {
    it("splits combined key when other descriptors have npm:", () => {
      const lockfile: ParsedLockfile = {
        __metadata: {},
        "my-pkg@workspace:packages/my-pkg, my-pkg@npm:^1.0.0": {
          version: "1.0.0",
        },
      };
      const count = normalizeCombinedKeysForLocalPackage(lockfile, "my-pkg", "packages/my-pkg");
      expect(count).toBe(1);
      expect(lockfile).toHaveProperty("my-pkg@workspace:packages/my-pkg");
      expect(lockfile).not.toHaveProperty("my-pkg@workspace:packages/my-pkg, my-pkg@npm:^1.0.0");
    });

    it("skips combined key when other descriptors lack protocol/npm", () => {
      const lockfile: ParsedLockfile = {
        __metadata: {},
        "my-pkg@workspace:packages/my-pkg, my-pkg@unknown:something": {
          version: "1.0.0",
        },
      };
      const count = normalizeCombinedKeysForLocalPackage(lockfile, "my-pkg", "packages/my-pkg");
      expect(count).toBe(0);
      expect(lockfile).toHaveProperty("my-pkg@workspace:packages/my-pkg, my-pkg@unknown:something");
    });
  });

  describe("enrichNpmBlockSpecifiers", () => {
    it("enriches with tilde range prefix", () => {
      const lockfile = {
        __metadata: {},
        "ms@npm:^2.1.0": { version: "2.1.3", resolution: "ms@npm:2.1.3" },
        "debug@npm:^4.0.0": {
          version: "4.3.4",
          resolution: "debug@npm:4.3.4",
          dependencies: { ms: "npm:~2.1.0" },
        },
      };
      const count = enrichNpmBlockSpecifiers(lockfile, vi.fn());
      expect(count).toBe(1);
      const msKey = Object.keys(lockfile).find((k) => k.includes("ms@npm:"));
      expect(msKey).toContain("ms@npm:~2.1.0");
    });

    it("sorts ≥2 specifiers when enriching", () => {
      const lockfile = {
        __metadata: {},
        "ms@npm:^2.1.0": { version: "2.1.3", resolution: "ms@npm:2.1.3" },
        "debug@npm:^4.0.0": {
          version: "4.3.4",
          resolution: "debug@npm:4.3.4",
          dependencies: { ms: "npm:^2.0.0" },
        },
      };
      const count = enrichNpmBlockSpecifiers(lockfile, vi.fn());
      expect(count).toBe(1);
      const msKey = Object.keys(lockfile).find((k) => k.includes("ms@npm:"));
      expect(msKey).toBeDefined();
      expect(msKey).toContain("ms@npm:^2.0.0");
      expect(msKey).toContain("ms@npm:^2.1.0");
      expect((msKey ?? "").indexOf("^2.0.0")).toBeLessThan((msKey ?? "").indexOf("^2.1.0"));
    });
  });

  describe("getDependenciesFromManifests", () => {
    const workspaceManifest: WorkspaceManifest = {
      packages: [{ name: "ws-pkg", version: "1.0.0", dependencies: { dep: "^1.0.0" } }],
    };
    const log = vi.fn();

    it("returns null when skipWorkspaceManifest and no backstage manifest", async () => {
      const result = await getDependenciesFromManifests(
        "some-pkg",
        "1.0.0",
        workspaceManifest,
        null,
        log,
        { skipWorkspaceManifest: true },
      );
      expect(result).toBeNull();
    });

    it("returns null-filled metadata from minimal backstage manifest entry", async () => {
      const backstage: BackstageManifest = {
        backstageVersion: "1.0.0",
        packages: [{ name: "pkg", version: "1.0.0" }],
      };
      const result = await getDependenciesFromManifests(
        "pkg",
        "1.0.0",
        workspaceManifest,
        backstage,
        log,
        {
          skipWorkspaceManifest: true,
        },
      );
      expect(result).toEqual({
        dependencies: null,
        optionalDependencies: null,
        peerDependencies: null,
        peerDependenciesMeta: null,
        bin: null,
      });
    });
  });

  describe("fetchNpmMetadataForBlock", () => {
    it("merges optionalDependencies into dependencies when npm has no deps", async () => {
      mockFetch({
        "https://registry.npmjs.org/opt-only-pkg/1.0.0": {
          name: "opt-only-pkg",
          version: "1.0.0",
          optionalDependencies: { "opt-a": "^1.0.0" },
        },
      });
      const result = await fetchNpmMetadataForBlock("opt-only-pkg", "1.0.0", vi.fn());
      expect(result).toEqual({
        dependencies: { "opt-a": "^1.0.0" },
        dependenciesMeta: { "opt-a": { optional: true } },
        peerDependencies: null,
        peerDependenciesMeta: null,
        bin: null,
      });
    });
  });
});
