import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { skipExistingFile } from "./fs-utils.ts";
import { makeTempDir } from "./test-utils.ts";

describe("skipExistingFile", () => {
  it("allows copy when the destination does not exist", () => {
    using dir = makeTempDir();
    const dest = path.join(dir.path, "missing.txt");

    expect(skipExistingFile(path.join(dir.path, "src.txt"), dest)).toBe(true);
  });

  it("skips when the destination is an existing file", () => {
    using dir = makeTempDir();
    const dest = path.join(dir.path, "existing.txt");
    fs.writeFileSync(dest, "keep");

    expect(skipExistingFile(path.join(dir.path, "src.txt"), dest)).toBe(false);
  });

  it("allows traversal when the destination is a directory", () => {
    using dir = makeTempDir();
    const dest = path.join(dir.path, "nested");
    fs.mkdirSync(dest);

    expect(skipExistingFile(path.join(dir.path, "src"), dest)).toBe(true);
  });

  it("preserves existing files when used with fs.cpSync", () => {
    using src = makeTempDir();
    using dest = makeTempDir();
    fs.mkdirSync(path.join(src.path, "nested"), { recursive: true });
    fs.mkdirSync(path.join(dest.path, "nested"), { recursive: true });
    fs.writeFileSync(path.join(src.path, "nested", "both.txt"), "from-src");
    fs.writeFileSync(path.join(src.path, "nested", "only-src.txt"), "src");
    fs.writeFileSync(path.join(dest.path, "nested", "both.txt"), "from-dest");

    fs.cpSync(src.path, dest.path, { recursive: true, filter: skipExistingFile });

    expect(fs.readFileSync(path.join(dest.path, "nested", "both.txt"), "utf8")).toBe("from-dest");
    expect(fs.readFileSync(path.join(dest.path, "nested", "only-src.txt"), "utf8")).toBe("src");
  });
});
