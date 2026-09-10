import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { loadFixture, makeTempDir, testInputOutputExpectations } from "../../test-utils.ts";
import {
  collectEmbeddedPackageNames,
  filterPluginsListBySupported,
  normalizeWorkspacePath,
  parsePluginsListYaml,
  parseTierListFile,
  removeInfrastructureDirs,
  run,
  shouldKeepPackageDir,
} from "./index.ts";

/**
 * Fixture catalog (`__fixtures__/<name>/` — name doubles as the Vitest case title):
 *
 * - `preserves-supported-plugins-removes-infrastructure-and-rewrites-plugins-list` —
 *   whitelist filter (plugins/ and packages/ paths), infrastructure removal
 *   (examples/, packages/app, backend, app-next, .storybook, node_modules),
 *   dist-dynamic/ preserved for supported plugins, comments and blank lines kept in
 *   plugins-list rewrite, CLI args preserved on surviving entries
 * - `preserves-embedded-source-by-npm-name-and-removes-unrelated-plugin` — embedded
 *   package source kept via dist-dynamic/embedded name match; unrelated plugin removed
 * - `removes-all-plugin-dirs-when-no-plugins-list-entries-are-supported` — empty
 *   surviving list; all plugin dirs removed
 * - `throws-when-rhdh-supported-packages-txt-is-missing` — error when tier list absent
 * - `throws-when-plugins-list-yaml-is-missing` — error when plugins-list absent
 */
describe("plugin-removal", () => {
  testInputOutputExpectations(import.meta.dirname, run);
});

describe("parsePluginsListYaml", () => {
  it("parses paths and preserves raw lines with CLI args", () => {
    const entries = parsePluginsListYaml(`
# comment
plugins/foo:
plugins/bar: --embed-package @scope/pkg
`);
    expect(entries).toEqual([
      { rawLine: "plugins/foo:", pluginPath: "plugins/foo" },
      { rawLine: "plugins/bar: --embed-package @scope/pkg", pluginPath: "plugins/bar" },
    ]);
  });

  it("skips lines with spaces in the plugin path", () => {
    const entries = parsePluginsListYaml("some random text\nplugins/valid:");
    expect(entries).toEqual([{ rawLine: "plugins/valid:", pluginPath: "plugins/valid" }]);
  });
});

describe("filterPluginsListBySupported", () => {
  it("keeps only entries present in the supported tier list", () => {
    const entries = parsePluginsListYaml("plugins/a:\nplugins/b:");
    const supported = new Set(["ws/plugins/a"]);
    expect(filterPluginsListBySupported(entries, "ws", supported).map((e) => e.pluginPath)).toEqual(
      ["plugins/a"],
    );
  });
});

describe("normalizeWorkspacePath", () => {
  it("strips trailing /.", () => {
    expect(normalizeWorkspacePath("pagerduty/.")).toBe("pagerduty");
    expect(normalizeWorkspacePath("pagerduty/plugins/foo")).toBe("pagerduty/plugins/foo");
  });
});

describe("parseTierListFile", () => {
  it("skips comments and blank lines", () => {
    expect(parseTierListFile("# header\n\nws/plugins/a\n")).toEqual(["ws/plugins/a"]);
  });
});

describe("removeInfrastructureDirs", () => {
  it("skips file matches that are not directories", () => {
    using tmp = makeTempDir();
    const packagesDir = path.join(tmp.path, "packages");
    fs.mkdirSync(packagesDir, { recursive: true });
    fs.writeFileSync(path.join(packagesDir, "backend"), "not a directory");
    const log = vi.fn();
    removeInfrastructureDirs(tmp.path, log);
    expect(fs.existsSync(path.join(packagesDir, "backend"))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("collectEmbeddedPackageNames", () => {
  it("skips malformed package.json in embedded dirs", () => {
    using tmp = loadFixture(
      import.meta.dirname,
      "preserves-embedded-source-by-npm-name-and-removes-unrelated-plugin",
    );
    const embeddedDir = path.join(
      tmp.ctx.workspacePath,
      "plugins/exported-plugin/dist-dynamic/embedded/bad-pkg",
    );
    fs.mkdirSync(embeddedDir, { recursive: true });
    fs.writeFileSync(path.join(embeddedDir, "package.json"), "{ broken");
    const names = collectEmbeddedPackageNames(tmp.ctx.workspacePath);
    expect(names.has("@example/embedded-lib")).toBe(true);
    expect(names.has("@example/another-lib")).toBe(true);
    expect(names.size).toBe(2);
  });

  it("skips package.json without a name field", () => {
    using tmp = loadFixture(
      import.meta.dirname,
      "preserves-embedded-source-by-npm-name-and-removes-unrelated-plugin",
    );
    const embeddedDir = path.join(
      tmp.ctx.workspacePath,
      "plugins/exported-plugin/dist-dynamic/embedded/no-name",
    );
    fs.mkdirSync(embeddedDir, { recursive: true });
    fs.writeFileSync(path.join(embeddedDir, "package.json"), '{"version": "1.0.0"}');
    const names = collectEmbeddedPackageNames(tmp.ctx.workspacePath);
    expect(names.has("@example/embedded-lib")).toBe(true);
    expect(names.has("@example/another-lib")).toBe(true);
    expect(names.size).toBe(2);
  });
});

describe("shouldKeepPackageDir", () => {
  it("keeps listed plugin paths, dist-dynamic dirs, and embedded package names", () => {
    const fixture = loadFixture(
      import.meta.dirname,
      "preserves-embedded-source-by-npm-name-and-removes-unrelated-plugin",
    );
    const keep = new Set(["plugins/exported-plugin"]);
    const embedded = new Set(["@example/embedded-lib"]);
    const ws = fixture.ctx.workspacePath;

    expect(shouldKeepPackageDir(`${ws}/plugins/exported-plugin`, ws, keep, embedded)).toBe(true);
    expect(
      shouldKeepPackageDir(`${ws}/plugins/exported-plugin/dist-dynamic`, ws, keep, embedded),
    ).toBe(true);
    expect(shouldKeepPackageDir(`${ws}/plugins/embedded-lib-source`, ws, keep, embedded)).toBe(
      true,
    );
    expect(shouldKeepPackageDir(`${ws}/plugins/remove-me`, ws, keep, embedded)).toBe(false);
  });

  it("returns false when package.json is malformed", () => {
    using tmp = loadFixture(
      import.meta.dirname,
      "preserves-embedded-source-by-npm-name-and-removes-unrelated-plugin",
    );
    const ws = tmp.ctx.workspacePath;
    const badDir = `${ws}/plugins/bad-json`;
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(`${badDir}/package.json`, "{ invalid json");
    expect(shouldKeepPackageDir(badDir, ws, new Set(), new Set(["anything"]))).toBe(false);
  });
});
