import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  loadFixture,
  mockFetch,
  type MockFetchResponse,
  testInputOutputExpectations,
} from "../../test-utils.ts";
import {
  run,
  extractBackstageEntries,
  extractPackageInfo,
  findWorkspacePackageJsonFiles,
  getBackstageVersion,
  normalizeBin,
} from "./index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generate-manifests", () => {
  testInputOutputExpectations(import.meta.dirname, run, {
    setup: (fixture, fixtureDir) => {
      const releaseFile = path.join(fixtureDir, "remote-backstage-manifest.json");
      if (!fs.existsSync(releaseFile)) return;

      const backstageJsonPath = path.join(fixture.ctx.workspacePath, "backstage.json");
      if (!fs.existsSync(backstageJsonPath)) return;

      const version = JSON.parse(fs.readFileSync(backstageJsonPath, "utf8")).version;
      const responseBody = JSON.parse(fs.readFileSync(releaseFile, "utf8"));
      mockFetch({
        [`https://versions.backstage.io/v1/releases/${version}/manifest.json`]: responseBody,
      });
    },
  });

  it("logs package counts for workspace with backstage deps", async () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-with-backstage");
    const releaseFile = path.join(
      import.meta.dirname,
      "__fixtures__/monorepo-with-backstage/remote-backstage-manifest.json",
    );
    const version = "1.42.5";
    mockFetch({
      [`https://versions.backstage.io/v1/releases/${version}/manifest.json`]: JSON.parse(
        fs.readFileSync(releaseFile, "utf8"),
      ),
    });
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringContaining("Found"));
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringContaining("Manifest written to:"));
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("Written: backstage-manifest.json"),
    );
  });

  it("throws when versions.backstage.io returns HTTP error", async () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-with-backstage");
    const version = "1.42.5";
    mockFetch({
      [`https://versions.backstage.io/v1/releases/${version}/manifest.json`]: {
        body: null,
        status: 503,
        ok: false,
      } satisfies MockFetchResponse,
    });
    await expect(run(fixture.ctx)).rejects.toThrow(/HTTP 503/);
  });

  it("throws when manifest response has no packages array", async () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-with-backstage");
    const version = "1.42.5";
    mockFetch({
      [`https://versions.backstage.io/v1/releases/${version}/manifest.json`]: {
        releaseVersion: version,
      },
    });
    await expect(run(fixture.ctx)).rejects.toThrow(/invalid Backstage manifest response/);
  });

  it("skips malformed entries in manifest packages array", async () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-with-backstage");
    const version = "1.42.5";
    mockFetch({
      [`https://versions.backstage.io/v1/releases/${version}/manifest.json`]: {
        packages: [
          null,
          42,
          { name: "@backstage/core-plugin-api", version: "1.10.9" },
          { name: "@backstage/theme", version: "0.6.3" },
          { name: "@backstage/types", version: "1.2.3" },
          { name: "@backstage/catalog-model", version: "1.8.1" },
          { noVersion: true },
          { name: 123, version: "1.0.0" },
        ],
      },
    });
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringContaining("Found"));
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractBackstageEntries
// ---------------------------------------------------------------------------

describe("extractBackstageEntries", () => {
  it("extracts all field types from a complete lockfile", () => {
    const lockContent = `
# Unrelated npm package — should be ignored.
"react@npm:^18.0.0":
  version: 18.3.1
  resolution: "react@npm:18.3.1"
  checksum: def

# Valid @backstage row with dependencies and bin.
"@backstage/core-plugin-api@backstage:^":
  version: 1.10.9
  resolution: "@backstage/core-plugin-api@npm:1.10.9"
  dependencies:
    "@backstage/types": "npm:^1.2.3"
  bin:
    backstage-cli: ./bin/backstage-cli
  checksum: abc123

# Valid @backstage row with peers, peerDependenciesMeta, optionalDependencies.
"@backstage/theme@backstage:^":
  version: 0.6.3
  resolution: "@backstage/theme@npm:0.6.3"
  peerDependencies:
    react: "npm:^18.0.0"
  peerDependenciesMeta:
    react:
      optional: true
    # Scoped key must be quoted for parseSyml.
    "@emotion/react":
      reason: styling
      optional: false
  optionalDependencies:
    "@emotion/react": "npm:^11.0.0"
  checksum: xyz789
`;
    const entries = extractBackstageEntries(lockContent);
    expect(entries).toHaveLength(2);

    expect(entries[0]).toEqual({
      name: "@backstage/core-plugin-api",
      version: "1.10.9",
      dependencies: { "@backstage/types": "npm:^1.2.3" },
      bin: { "backstage-cli": "./bin/backstage-cli" },
    });

    expect(entries[1]).toEqual({
      name: "@backstage/theme",
      version: "0.6.3",
      peerDependencies: { react: "npm:^18.0.0" },
      peerDependenciesMeta: {
        react: { optional: true },
        "@emotion/react": { reason: "styling", optional: false },
      },
      optionalDependencies: { "@emotion/react": "npm:^11.0.0" },
    });
  });

  it("extracts from compound lockfile keys (comma-separated aliases)", () => {
    const body = `
  version: 1.10.9
  resolution: "@backstage/core-plugin-api@npm:1.10.9"
  dependencies:
    "@backstage/types": "npm:^1.2.3"
  checksum: abc
`;
    const npmFirst = `
"@backstage/core-plugin-api@npm:1.10.9, @backstage/core-plugin-api@backstage:^":${body}`;
    const backstageFirst = `
"@backstage/core-plugin-api@backstage:^, @backstage/core-plugin-api@npm:1.10.9":${body}`;

    const expected = {
      name: "@backstage/core-plugin-api",
      version: "1.10.9",
      dependencies: { "@backstage/types": "npm:^1.2.3" },
    };

    expect(extractBackstageEntries(npmFirst)).toEqual([expected]);
    expect(extractBackstageEntries(backstageFirst)).toEqual([expected]);
  });

  it("skips entries with malformed descriptor, missing version, or no backstage deps", () => {
    const lockContent = `
# npm-only key — not @backstage / backstage:.
"react@npm:^18.0.0":
  version: 18.3.1
  checksum: def

# Descriptor without a package name.
"backstage:^":
  version: 1.0.0
  resolution: "something@npm:1.0.0"
  checksum: abc

# @backstage key but no string version field.
"@backstage/core-plugin-api@backstage:^":
  resolution: "@backstage/core-plugin-api@npm:1.10.9"
  checksum: abc

# backstage: protocol on a non-@backstage package name.
"other@backstage:^":
  version: 1.2.3
  resolution: "other@npm:1.2.3"
  checksum: ghi

# @backstage scope but lock key has only an npm: alias (no backstage:).
"@backstage/only-npm@npm:1.0.0":
  version: 1.0.0
  checksum: npm-only

# Top-level scalar — entry body is not a mapping.
not-an-entry: scalar
`;
    expect(extractBackstageEntries(lockContent)).toEqual([]);
  });

  it("omits empty dependency and peerDependenciesMeta sections", () => {
    const lockContent = `
"@backstage/core-plugin-api@backstage:^":
  version: 1.10.9
  resolution: "@backstage/core-plugin-api@npm:1.10.9"
  # Empty maps — parseSyml yields null; fields should be omitted from output.
  dependencies:
  peerDependenciesMeta:
  checksum: abc
`;
    const entries = extractBackstageEntries(lockContent);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.dependencies).toBeUndefined();
    expect(entry?.peerDependenciesMeta).toBeUndefined();
  });

  it("omits dependency fields when all map entries are malformed", () => {
    const lockContent = [
      '"@backstage/core-plugin-api@backstage:^":',
      "  version: 1.10.9",
      '  resolution: "@backstage/core-plugin-api@npm:1.10.9"',
      "  dependencies:",
      "    # Key with null value — not a string semver range.",
      "    not-a-version:",
      "  checksum: abc",
    ].join("\n");
    const entries = extractBackstageEntries(lockContent);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.dependencies).toBeUndefined();
  });

  it("omits peerDependenciesMeta when all nested-map keys are malformed", () => {
    const lockContent = [
      '"@backstage/core-plugin-api@backstage:^":',
      "  version: 1.10.9",
      '  resolution: "@backstage/core-plugin-api@npm:1.10.9"',
      "  peerDependenciesMeta:",
      "    # Package entry must be a mapping, not a string.",
      '    react: "nope"',
      "  checksum: abc",
    ].join("\n");
    const entries = extractBackstageEntries(lockContent);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.peerDependenciesMeta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for normalizeBin
// ---------------------------------------------------------------------------

describe("normalizeBin", () => {
  const cases: Array<
    [string, string, string | Record<string, string>, Record<string, string> | undefined]
  > = [
    ["scoped string → object", "@scope/my-cli", "./dist/cli.js", { "my-cli": "./dist/cli.js" }],
    ["unscoped string → object", "my-tool", "./cli.js", { "my-tool": "./cli.js" }],
    [
      "object passthrough",
      "@scope/pkg",
      { "tool-a": "./a.js", "tool-b": "./b.js" },
      { "tool-a": "./a.js", "tool-b": "./b.js" },
    ],
    ["empty object → undefined", "@scope/pkg", {}, undefined],
  ];

  it.each(cases)("%s", (_label, name, bin, expected) => {
    expect(normalizeBin(name, bin)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for findWorkspacePackageJsonFiles
// ---------------------------------------------------------------------------

describe("findWorkspacePackageJsonFiles", () => {
  it("finds root package.json for flat repo (no workspaces field)", () => {
    using fixture = loadFixture(import.meta.dirname, "flat-repo-single-package");
    const files = findWorkspacePackageJsonFiles(fixture.ctx.workspacePath);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("package.json");
  });

  it("finds root + workspace members for monorepo", () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-no-backstage");
    const files = findWorkspacePackageJsonFiles(fixture.ctx.workspacePath);
    expect(files).toHaveLength(3);
  });

  it("handles edge cases: missing root, dist-dynamic exclusion, empty glob match", () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-no-backstage");
    const wp = fixture.ctx.workspacePath;

    fs.mkdirSync(path.join(wp, "plugins", "empty-dir"), { recursive: true });
    expect(findWorkspacePackageJsonFiles(wp)).toHaveLength(3);

    const distDir = path.join(wp, "plugins", "dist-dynamic");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "package.json"),
      JSON.stringify({ name: "should-be-excluded", version: "0.0.0" }),
    );
    expect(findWorkspacePackageJsonFiles(wp)).toHaveLength(3);
    expect(findWorkspacePackageJsonFiles(wp).every((f) => !f.includes("dist-dynamic"))).toBe(true);

    fs.unlinkSync(path.join(wp, "package.json"));
    expect(findWorkspacePackageJsonFiles(wp)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for getBackstageVersion
// ---------------------------------------------------------------------------

describe("getBackstageVersion", () => {
  it("reads version from backstage.json", () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-with-backstage");
    expect(getBackstageVersion(fixture.ctx.workspacePath)).toBe("1.42.5");
  });

  it("throws when backstage.json is missing", () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-no-backstage");
    expect(() => getBackstageVersion(fixture.ctx.workspacePath)).toThrow(/no backstage\.json/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for extractPackageInfo
// ---------------------------------------------------------------------------

describe("extractPackageInfo", () => {
  it("returns null for missing name or version, filtering them from manifest", async () => {
    using fixture = loadFixture(import.meta.dirname, "monorepo-no-backstage");
    const rootPkgPath = path.join(fixture.ctx.workspacePath, "package.json");
    const content = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

    fs.writeFileSync(rootPkgPath, JSON.stringify({ ...content, name: undefined }));
    expect(extractPackageInfo(rootPkgPath, fixture.ctx.workspacePath)).toBeNull();

    fs.writeFileSync(rootPkgPath, JSON.stringify({ ...content, version: undefined }));
    expect(extractPackageInfo(rootPkgPath, fixture.ctx.workspacePath)).toBeNull();

    fs.writeFileSync(rootPkgPath, JSON.stringify(content));
    const alphaPath = path.join(
      fixture.ctx.workspacePath,
      "plugins",
      "plugin-alpha",
      "package.json",
    );
    fs.writeFileSync(alphaPath, JSON.stringify({ version: "1.0.0" }));
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringMatching(/Found 2 local packages/));
  });
});
