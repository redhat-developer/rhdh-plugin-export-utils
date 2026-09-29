import { describe, expect, it } from "vite-plus/test";

import { loadFixture, testInputOutputExpectations } from "../../test-utils.ts";
import { run } from "./index.ts";

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
});
