import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadFixture, testInputOutputExpectations } from "../../test-utils.ts";
import { run, runWithDeps } from "./index.ts";

describe("hermetic-prep", () => {
  testInputOutputExpectations(import.meta.dirname, run);

  it("logs when packageManager is removed", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringContaining("removed packageManager"));
  });

  it("logs when a monorepo postinstall is removed", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-inline-monorepo-postinstall");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("removed monorepo postinstall"),
    );
  });

  it("downloads Yarn from packageManager when yarnPath binary is missing", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(fixture.ctx.workspacePath, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );

    const downloadYarn = vi.fn(async (version: string, destPath: string) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, `downloaded-yarn-${version}\n`);
    });

    await runWithDeps(fixture.ctx, { downloadYarn });

    expect(downloadYarn).toHaveBeenCalledWith("4.9.2", expect.stringContaining("yarn-4.9.2.cjs"));
    const yarnrc = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(yarnrc).toContain("yarnPath: .yarn/releases/yarn-4.9.2.cjs");
    expect(
      fs.readFileSync(
        path.join(fixture.ctx.workspacePath, ".yarn/releases/yarn-4.9.2.cjs"),
        "utf8",
      ),
    ).toBe("downloaded-yarn-4.9.2\n");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(fixture.ctx.workspacePath, "package.json"), "utf8"),
    );
    expect(pkg.packageManager).toBeUndefined();
  });

  it("fails when yarnPath is missing and packageManager cannot supply a version", async () => {
    using fixture = loadFixture(import.meta.dirname, "noop");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), { force: true });

    await expect(run(fixture.ctx)).rejects.toThrow(/No usable yarnPath/);
  });

  it("replaces an existing yarnPath when the binary is missing", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(fixture.ctx.workspacePath, ".yarnrc.yml"),
      "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-old.cjs\n",
    );

    const downloadYarn = vi.fn(async (_version: string, destPath: string) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, "downloaded\n");
    });

    await runWithDeps(fixture.ctx, { downloadYarn });

    const yarnrc = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(yarnrc).toContain("yarnPath: .yarn/releases/yarn-4.9.2.cjs");
    expect(yarnrc).not.toContain("yarn-old.cjs");
  });

  it("downloads Yarn via fetch when no downloadYarn inject is provided", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(fixture.ctx.workspacePath, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("real-download\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await run(fixture.ctx);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://repo.yarnpkg.com/4.9.2/packages/yarnpkg-cli/bin/yarn.js",
      );
      expect(
        fs.readFileSync(
          path.join(fixture.ctx.workspacePath, ".yarn/releases/yarn-4.9.2.cjs"),
          "utf8",
        ),
      ).toBe("real-download\n");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails when the default Yarn download returns a non-OK response", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(fixture.ctx.workspacePath, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }),
    );

    try {
      await expect(run(fixture.ctx)).rejects.toThrow(/HTTP 503/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates .yarnrc.yml when downloading Yarn with no existing config", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), { force: true });

    const downloadYarn = vi.fn(async (_version: string, destPath: string) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, "downloaded\n");
    });

    await runWithDeps(fixture.ctx, { downloadYarn });

    const yarnrc = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(yarnrc).toBe("yarnPath: .yarn/releases/yarn-4.9.2.cjs\n");
  });

  it("ensures replaced yarnPath lines end with a newline", async () => {
    using fixture = loadFixture(import.meta.dirname, "remove-packagemanager");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    // No trailing newline — exercises setYarnPath replace + writeJson newline guard
    fs.writeFileSync(
      path.join(fixture.ctx.workspacePath, ".yarnrc.yml"),
      "yarnPath: .yarn/releases/yarn-old.cjs",
    );

    const downloadYarn = vi.fn(async (_version: string, destPath: string) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, "downloaded\n");
    });

    await runWithDeps(fixture.ctx, { downloadYarn });

    const yarnrc = fs.readFileSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), "utf8");
    expect(yarnrc).toBe("yarnPath: .yarn/releases/yarn-4.9.2.cjs\n");
  });

  it("fails when yarn binary and root package.json are both missing", async () => {
    using fixture = loadFixture(import.meta.dirname, "no-root-package-json");
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarn"), { recursive: true, force: true });
    fs.rmSync(path.join(fixture.ctx.workspacePath, ".yarnrc.yml"), { force: true });

    await expect(run(fixture.ctx)).rejects.toThrow(/No usable yarnPath/);
  });
});
