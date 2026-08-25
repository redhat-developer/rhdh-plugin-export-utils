import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readSourceFile } from "./source.ts";
import { makeTempDir } from "./test-utils.ts";

const VALID_SOURCE = {
  repo: "https://github.com/example/repo",
  "repo-ref": "abc123",
  "repo-flat": false,
  "repo-backstage-version": "1.45.1",
};

function writeSource(dir: string, content: unknown): string {
  const filePath = path.join(dir, "source.json");
  fs.writeFileSync(filePath, JSON.stringify(content));
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

  it("throws when the JSON is not an object", () => {
    using tmp = makeTempDir();
    for (const value of ["hello", 42, true, null, [1, 2]]) {
      const filePath = writeSource(tmp.path, value);
      expect(() => readSourceFile(filePath)).toThrow(
        expect.objectContaining({
          message: `Failed to load '${filePath}'`,
          cause: expect.objectContaining({ message: "Expected a JSON object" }),
        }),
      );
    }
  });

  it("throws when a required field is missing", () => {
    using tmp = makeTempDir();
    for (const field of ["repo", "repo-ref", "repo-flat", "repo-backstage-version"]) {
      const incomplete: Record<string, unknown> = { ...VALID_SOURCE };
      delete incomplete[field];
      const filePath = writeSource(tmp.path, incomplete);
      expect(() => readSourceFile(filePath)).toThrow(
        expect.objectContaining({
          message: `Failed to load '${filePath}'`,
          cause: expect.objectContaining({ message: `Missing required field "${field}"` }),
        }),
      );
    }
  });

  it("throws when a field has the wrong type", () => {
    using tmp = makeTempDir();

    const filePath = writeSource(tmp.path, { ...VALID_SOURCE, repo: 123 });
    expect(() => readSourceFile(filePath)).toThrow(
      expect.objectContaining({
        message: `Failed to load '${filePath}'`,
        cause: expect.objectContaining({
          message: 'Field "repo" must be a string, got number',
        }),
      }),
    );

    const filePath2 = writeSource(tmp.path, { ...VALID_SOURCE, "repo-flat": "yes" });
    expect(() => readSourceFile(filePath2)).toThrow(
      expect.objectContaining({
        message: `Failed to load '${filePath2}'`,
        cause: expect.objectContaining({
          message: 'Field "repo-flat" must be a boolean, got string',
        }),
      }),
    );
  });
});
