import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { mockFetch, testInputOutputExpectations } from "../../test-utils.ts";
import { clearNpmMetadataCache } from "./npm-metadata.ts";
import { caretOrTildeSatisfies } from "./semver-range.ts";
import { buildVersionMap } from "./version-map.ts";
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
        const packageName = scoped.startsWith("@") ? scoped : scoped;
        const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;
        mappings[url] = JSON.parse(fs.readFileSync(path.join(npmResponsesDir, file), "utf8"));
      }
      if (Object.keys(mappings).length > 0) mockFetch(mappings);
    },
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
});
