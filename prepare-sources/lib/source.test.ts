import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import { writeJsonFile } from "./fs-utils.ts";
import { readSourceFile, type SourceJson } from "./source.ts";
import { makeTempDir } from "./test-utils.ts";

const VALID_SOURCE: SourceJson = {
  repo: "https://github.com/example/repo",
  "repo-ref": "abc123",
  "repo-flat": false,
  "repo-backstage-version": "1.45.1",
};

function writeSource(dir: string, content: unknown): string {
  const filePath = path.join(dir, "source.json");
  writeJsonFile(filePath, content);
  return filePath;
}

describe("readSourceFile", () => {
  it("returns parsed source for a valid file", () => {
    using tmp = makeTempDir();
    const filePath = writeSource(tmp.path, VALID_SOURCE);
    expect(readSourceFile(filePath)).toEqual(VALID_SOURCE);
  });

  it("throws when the file does not exist", () => {
    expect(() => readSourceFile("/nonexistent/source.json")).toThrow(
      "Failed to load '/nonexistent/source.json': file not found",
    );
  });

  it("throws when the file contains invalid JSON", () => {
    using tmp = makeTempDir();
    const filePath = path.join(tmp.path, "source.json");
    fs.writeFileSync(filePath, "{not json");
    expect(() => readSourceFile(filePath)).toThrow(`Failed to load '${filePath}': invalid JSON`);
  });

  it("wraps schema validation failures", () => {
    using tmp = makeTempDir();
    const filePath = writeSource(tmp.path, { ...VALID_SOURCE, repo: 123 });
    expect(() => readSourceFile(filePath)).toThrow(
      expect.objectContaining({
        message: `Failed to load '${filePath}'`,
        cause: expect.any(z.ZodError),
      }),
    );
  });
});
