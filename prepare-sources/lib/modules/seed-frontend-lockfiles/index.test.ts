import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { loadFixture, makeTempDir, testInputOutputExpectations } from "../../test-utils.ts";
import { getPluginType, run } from "./index.ts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

beforeEach(() => {
  vi.mocked(execFileSync).mockReset();
});

// ---------------------------------------------------------------------------
// Unit tests for getPluginType
// ---------------------------------------------------------------------------

describe("getPluginType", () => {
  it("returns 'none' when file does not exist", () => {
    expect(getPluginType("/nonexistent/package.json")).toBe("none");
  });

  it("returns 'frontend' for frontend-plugin role", () => {
    using fixture = loadFixture(import.meta.dirname, "seeds-frontend-plugin-missing-lockfile");
    const pkgPath = path.join(fixture.ctx.workspacePath, "plugins/my-frontend/package.json");
    expect(getPluginType(pkgPath)).toBe("frontend");
  });

  it("returns 'backend' for backend-plugin role", () => {
    using fixture = loadFixture(import.meta.dirname, "skips-backend-plugin-with-existing-lockfile");
    const pkgPath = path.join(fixture.ctx.workspacePath, "plugins/my-backend/package.json");
    expect(getPluginType(pkgPath)).toBe("backend");
  });

  it("returns 'none' for missing backstage field", () => {
    using fixture = loadFixture(import.meta.dirname, "skips-plugin-without-backstage-role");
    const pkgPath = path.join(fixture.ctx.workspacePath, "plugins/some-lib/package.json");
    expect(getPluginType(pkgPath)).toBe("none");
  });

  it("returns 'none' for unrecognized role", () => {
    using tmp = makeTempDir();
    const pkgPath = path.join(tmp.path, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ backstage: { role: "common-library" } }));
    expect(getPluginType(pkgPath)).toBe("none");
  });

  it("returns 'none' when backstage.role is not a string", () => {
    using tmp = makeTempDir();
    const pkgPath = path.join(tmp.path, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ backstage: { role: 42 } }));
    expect(getPluginType(pkgPath)).toBe("none");
  });

  it("returns 'none' when JSON is not an object", () => {
    using tmp = makeTempDir();
    const pkgPath = path.join(tmp.path, "package.json");
    fs.writeFileSync(pkgPath, '"just a string"');
    expect(getPluginType(pkgPath)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Fixture-based tests
// ---------------------------------------------------------------------------

/**
 * Fixture catalog (`__fixtures__/<name>/` — name doubles as the Vitest case title):
 *
 * - `noop-when-no-dist-dynamic-dirs` — workspace has plugins but no
 *   dist-dynamic/ directories at all
 * - `seeds-frontend-and-skips-backend-in-mixed-workspace` — workspace with
 *   both frontend (needs seeding) and backend (already has lockfile) plugins;
 *   composition test for multi-plugin workspaces
 * - `seeds-frontend-plugin-missing-lockfile` — frontend plugin with
 *   dist-dynamic/ but no yarn.lock; workspace yarn.lock is copied in and
 *   yarn install is invoked
 * - `skips-backend-plugin-with-existing-lockfile` — backend plugin whose
 *   dist-dynamic/ already has a yarn.lock from rhdh-cli; no action taken
 * - `skips-frontend-plugin-when-lockfile-already-exists` — frontend plugin
 *   whose dist-dynamic/ already has a yarn.lock; no action taken
 * - `skips-plugin-without-backstage-role` — plugin with no backstage.role
 *   field; treated as "none" and skipped
 * - `throws-when-workspace-lockfile-missing` — frontend plugin with
 *   dist-dynamic/ but no workspace yarn.lock; module throws
 */
describe("seed-frontend-lockfiles", () => {
  testInputOutputExpectations(import.meta.dirname, run);

  it("logs seeding and skipping in a mixed workspace", async () => {
    using fixture = loadFixture(
      import.meta.dirname,
      "seeds-frontend-and-skips-backend-in-mixed-workspace",
    );
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("backend plugin, skipping"),
    );
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("seeding dist-dynamic/yarn.lock"),
    );
    expect(fixture.ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("dist-dynamic/yarn.lock seeded"),
    );
  });

  it("logs when no dist-dynamic directories are found", async () => {
    using fixture = loadFixture(import.meta.dirname, "noop-when-no-dist-dynamic-dirs");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith("no dist-dynamic directories found");
  });

  it("throws when yarn install fails", async () => {
    using fixture = loadFixture(import.meta.dirname, "seeds-frontend-plugin-missing-lockfile");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("Command failed"), {
        stderr: Buffer.from("some yarn error output"),
        stdout: Buffer.from(""),
      });
    });
    await expect(run(fixture.ctx)).rejects.toThrow(/yarn install failed/);
  });

  it("throws with message even when error has no stderr", async () => {
    using fixture = loadFixture(import.meta.dirname, "seeds-frontend-plugin-missing-lockfile");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("Command failed");
    });
    await expect(run(fixture.ctx)).rejects.toThrow(/yarn install failed/);
  });
});
