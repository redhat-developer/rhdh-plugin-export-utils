import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadFixture, makeTempDir, testInputOutputExpectations } from "../../test-utils.ts";
import { findVersionsJson, readCliVersions, run, runWithDeps, tarballFileName } from "./index.ts";

describe("inject-build-tools", () => {
  testInputOutputExpectations(import.meta.dirname, run);

  describe("package.json file: reference", () => {
    it("logs when setting the file: devDependency", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      await run(fixture.ctx);
      expect(fixture.ctx.log).toHaveBeenCalledWith(
        expect.stringContaining('set devDependencies["@red-hat-developer-hub/cli"]'),
      );
      expect(fixture.ctx.log).toHaveBeenCalledWith(
        expect.stringContaining("file:.yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz"),
      );
    });

    it("preserves other existing dependencies when injecting the CLI", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      await run(fixture.ctx);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(fixture.ctx.workspacePath, "package.json"), "utf8"),
      );
      expect(pkg.devDependencies.typescript).toBe("^5.0.0");
      expect(pkg.devDependencies["@red-hat-developer-hub/cli"]).toBe(
        "file:.yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz",
      );
    });

    it("uses the default package name when cliPackage is omitted", async () => {
      using fixture = loadFixture(import.meta.dirname, "defaults-cli-package");
      await run(fixture.ctx);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(fixture.ctx.workspacePath, "package.json"), "utf8"),
      );
      expect(pkg.devDependencies).toEqual({
        "@red-hat-developer-hub/cli": "file:.yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz",
      });
    });

    it("honors a custom cliPackage from versions.json", async () => {
      using fixture = loadFixture(import.meta.dirname, "custom-cli-package");
      await run(fixture.ctx);
      const pkg = JSON.parse(
        fs.readFileSync(path.join(fixture.ctx.workspacePath, "package.json"), "utf8"),
      );
      expect(pkg.devDependencies["@example/offline-cli"]).toBe(
        "file:.yarn/cache/example-offline-cli-1.2.3.tgz",
      );
    });
  });

  describe("tarball cache / download", () => {
    it("does not call pack when the tarball is already present", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      const pack = vi.fn(async () => {
        throw new Error("pack should not be called");
      });
      await runWithDeps(fixture.ctx, { pack });
      expect(pack).not.toHaveBeenCalled();
      expect(fixture.ctx.log).toHaveBeenCalledWith(
        "tarball already present: .yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz",
      );
    });

    it("downloads the tarball when missing via injected pack", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn/cache"), {
        recursive: true,
        force: true,
      });

      const pack = vi.fn(async (_pkg: string, _ver: string, destDir: string) => {
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, "red-hat-developer-hub-cli-2.0.0.tgz"), "downloaded\n");
      });

      await runWithDeps(fixture.ctx, { pack });

      expect(pack).toHaveBeenCalledWith("@red-hat-developer-hub/cli", "2.0.0", expect.any(String));
      expect(
        fs.readFileSync(
          path.join(fixture.ctx.workspacePath, ".yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz"),
          "utf8",
        ),
      ).toBe("downloaded\n");
      const pkg = JSON.parse(
        fs.readFileSync(path.join(fixture.ctx.workspacePath, "package.json"), "utf8"),
      );
      expect(pkg.devDependencies["@red-hat-developer-hub/cli"]).toBe(
        "file:.yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz",
      );
    });

    it("creates .yarn/cache when downloading into a workspace without it", async () => {
      using fixture = loadFixture(import.meta.dirname, "defaults-cli-package");
      fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });

      const pack = vi.fn(async (_pkg: string, _ver: string, destDir: string) => {
        expect(fs.existsSync(destDir)).toBe(true);
        fs.writeFileSync(path.join(destDir, "red-hat-developer-hub-cli-2.0.0.tgz"), "packed\n");
      });

      await runWithDeps(fixture.ctx, { pack });
      expect(fs.existsSync(path.join(fixture.ctx.workspacePath, ".yarn/cache"))).toBe(true);
      expect(pack).toHaveBeenCalledOnce();
    });

    it("fails when pack throws", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn/cache"), {
        recursive: true,
        force: true,
      });

      await expect(
        runWithDeps(fixture.ctx, {
          pack: async () => {
            throw new Error("network unavailable");
          },
        }),
      ).rejects.toThrow("network unavailable");
    });

    it("fails when pack succeeds but the expected tarball file is missing", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn/cache"), {
        recursive: true,
        force: true,
      });

      await expect(
        runWithDeps(fixture.ctx, {
          pack: async (_pkg, _ver, destDir) => {
            fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(path.join(destDir, "wrong-name.tgz"), "oops\n");
          },
        }),
      ).rejects.toThrow(/Expected tarball 'red-hat-developer-hub-cli-2.0.0.tgz'/);
    });
  });

  describe("versions.json discovery and parsing", () => {
    it("finds versions.json in an ancestor of the overlay path", () => {
      using root = makeTempDir();
      const overlay = path.join(root.path, "workspaces", "topology");
      fs.mkdirSync(overlay, { recursive: true });
      fs.writeFileSync(
        path.join(root.path, "versions.json"),
        JSON.stringify({ cli: "2.0.0", cliPackage: "@red-hat-developer-hub/cli" }) + "\n",
      );

      const found = findVersionsJson(overlay);
      expect(found).toBe(path.join(root.path, "versions.json"));
      expect(readCliVersions(found)).toEqual({
        packageName: "@red-hat-developer-hub/cli",
        version: "2.0.0",
      });
    });

    it("defaults cliPackage when only cli is set", () => {
      using dir = makeTempDir();
      const versionsPath = path.join(dir.path, "versions.json");
      fs.writeFileSync(versionsPath, JSON.stringify({ cli: "9.9.9" }) + "\n");
      expect(readCliVersions(versionsPath)).toEqual({
        packageName: "@red-hat-developer-hub/cli",
        version: "9.9.9",
      });
    });

    it("rejects empty cli strings", () => {
      using dir = makeTempDir();
      const versionsPath = path.join(dir.path, "versions.json");
      fs.writeFileSync(versionsPath, JSON.stringify({ cli: "" }) + "\n");
      expect(() => readCliVersions(versionsPath)).toThrow(/Field "cli" must be a non-empty string/);
    });

    it("rejects non-object versions.json", () => {
      using dir = makeTempDir();
      const versionsPath = path.join(dir.path, "versions.json");
      fs.writeFileSync(versionsPath, '["not-an-object"]\n');
      expect(() => readCliVersions(versionsPath)).toThrow(/Expected a JSON object/);
    });
  });

  describe("tarballFileName", () => {
    it("derives npm pack tarball names for scoped packages", () => {
      expect(tarballFileName("@red-hat-developer-hub/cli", "2.0.0")).toBe(
        "red-hat-developer-hub-cli-2.0.0.tgz",
      );
    });

    it("derives npm pack tarball names for unscoped packages", () => {
      expect(tarballFileName("some-cli", "1.0.0")).toBe("some-cli-1.0.0.tgz");
    });
  });

  describe("end-to-end layout (overlay workspaces + repo-root versions.json)", () => {
    it("updates the workspace using versions.json two levels above the overlay", async () => {
      using root = makeTempDir();
      const overlay = path.join(root.path, "workspaces", "topology");
      const workspace = path.join(root.path, "source", "workspaces", "topology");
      fs.mkdirSync(overlay, { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });

      fs.writeFileSync(
        path.join(overlay, "source.json"),
        JSON.stringify({
          repo: "https://github.com/example/repo",
          "repo-ref": "abc123",
          "repo-flat": false,
          "repo-backstage-version": "1.45.1",
        }) + "\n",
      );
      fs.writeFileSync(
        path.join(root.path, "versions.json"),
        JSON.stringify({
          backstage: "1.52.0",
          cli: "2.0.0",
          cliPackage: "@red-hat-developer-hub/cli",
        }) + "\n",
      );
      fs.writeFileSync(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "topology", private: true }, null, 2) + "\n",
      );

      const pack = vi.fn(async (_pkg: string, _ver: string, destDir: string) => {
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, "red-hat-developer-hub-cli-2.0.0.tgz"), "e2e\n");
      });

      const log = vi.fn();
      await runWithDeps(
        {
          workspacePath: workspace,
          overlayPath: overlay,
          source: {
            repo: "https://github.com/example/repo",
            "repo-ref": "abc123",
            "repo-flat": false,
            "repo-backstage-version": "1.45.1",
          },
          log,
        },
        { pack },
      );

      const pkg = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8"));
      expect(pkg.devDependencies["@red-hat-developer-hub/cli"]).toBe(
        "file:.yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz",
      );
      expect(
        fs.existsSync(path.join(workspace, ".yarn/cache/red-hat-developer-hub-cli-2.0.0.tgz")),
      ).toBe(true);
      expect(pack).toHaveBeenCalledOnce();
    });
  });
});
