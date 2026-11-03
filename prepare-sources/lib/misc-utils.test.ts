import { describe, expect, it } from "vite-plus/test";

import { isRecord } from "./misc-utils.ts";

describe("isRecord", () => {
  it.each([
    [{ x: 1 }, true],
    [Object.create(null), true],
    [null, false],
    [undefined, false],
    ["s", false],
    [42, false],
    [[1], false],
  ] as const)("isRecord(%j) → %s", (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});
