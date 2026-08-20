import { describe, expect, it } from "vite-plus/test";

import { loadFixture, testInputOutputExpectations } from "../../test-utils.ts";
import { run } from "./index.ts";

/**
 * Template for module tests — demonstrates all 6 fixture conventions:
 *
 * - `success-without-mutation`        — no output/ → asserts nothing changed
 * - `success-with-workspace-mutation` — output/workspace/ only → overlay auto-checked unchanged
 * - `success-with-overlay-mutation`   — output/overlay/ only → workspace auto-checked unchanged
 * - `success-with-both-mutations`     — output/workspace/ + output/overlay/ → both asserted
 * - `error-string`                    — error file with plain substring match
 * - `error-regex`                     — error file with /regex/ match
 *
 * All fixtures are auto-iterated by `testInputOutputExpectations`.
 * Explicit `it()` tests below show behavioral assertions (logs).
 *
 * To test a real module:
 * 1. Copy this directory into `modules/<name>/`
 * 2. Replace `run` import with your module's export
 * 3. Create `__fixtures__/<case>/` directories
 * 4. `testInputOutputExpectations` auto-generates one test per fixture
 * 5. Add explicit tests for log or behavioral assertions
 */

describe("template", () => {
  testInputOutputExpectations(import.meta.dirname, run);

  it("logs progress on workspace mutation", async () => {
    const fixture = loadFixture(import.meta.dirname, "success-with-workspace-mutation");
    await run(fixture.ctx);
    expect(fixture.ctx.log).toHaveBeenCalledWith(expect.stringContaining("modified"));
  });
});
