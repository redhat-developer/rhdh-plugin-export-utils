import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadFixture, makeTempDir, testInputOutputExpectations } from "../../test-utils.ts";
import { writeJsonFile } from "../../fs-utils.ts";
import { npmPack, readCliVersions, run, runWithDeps, tarballFileName } from "./index.ts";

describe("inject-build-tools", () => {
  testInputOutputExpectations(import.meta.dirname, run);

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

    it("downloads the tarball when missing and creates .yarn/cache", async () => {
      using fixture = loadFixture(import.meta.dirname, "adds-file-devDependency");
      fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });

      const pack = vi.fn(async (_pkg: string, _ver: string, destDir: string) => {
        expect(fs.existsSync(destDir)).toBe(true);
        fs.writeFileSync(path.join(destDir, "red-hat-developer-hub-cli-2.0.0.tgz"), "downloaded\n");
      });

      await runWithDeps(fixture.ctx, { pack });

      expect(pack).toHaveBeenCalledWith("@red-hat-developer-hub/cli", "2.0.0", expect.any(String));
      expect(fs.existsSync(path.join(fixture.ctx.workspacePath, ".yarn/cache"))).toBe(true);
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

  it("rejects non-object versions.json", () => {
    using dir = makeTempDir();
    const versionsPath = path.join(dir.path, "versions.json");
    writeJsonFile(versionsPath, ["not-an-object"]);
    expect(() => readCliVersions(versionsPath)).toThrow(/Expected a JSON object/);
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

  describe("npmPack", () => {
    it("invokes npm pack into the destination directory", async () => {
      using dir = makeTempDir();
      const exec = vi.fn(async (file: string, args: readonly string[], options) => {
        expect(file).toBe("npm");
        expect(args).toEqual([
          "pack",
          "@red-hat-developer-hub/cli@2.0.0",
          `--pack-destination=${dir.path}`,
        ]);
        expect(options).toEqual({ encoding: "utf8", cwd: dir.path });
        fs.writeFileSync(path.join(dir.path, "red-hat-developer-hub-cli-2.0.0.tgz"), "packed\n");
        return { stdout: "red-hat-developer-hub-cli-2.0.0.tgz\n", stderr: "" };
      });

      await npmPack("@red-hat-developer-hub/cli", "2.0.0", dir.path, exec);

      expect(exec).toHaveBeenCalledOnce();
      expect(
        fs.readFileSync(path.join(dir.path, "red-hat-developer-hub-cli-2.0.0.tgz"), "utf8"),
      ).toBe("packed\n");
    });

    it("wraps npm pack failures with a download error", async () => {
      using dir = makeTempDir();
      const exec = vi.fn(async () => {
        throw new Error("npm unavailable");
      });

      await expect(npmPack("@red-hat-developer-hub/cli", "2.0.0", dir.path, exec)).rejects.toThrow(
        "Failed to download @red-hat-developer-hub/cli@2.0.0",
      );
    });
  });
});
