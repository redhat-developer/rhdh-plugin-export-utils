import fs from "node:fs";

/**
 * Contents of a workspace's `source.json` file, which describes the upstream
 * repository that provides the plugin source code.
 */
export interface SourceJson {
  /** Repository URL (e.g. `https://github.com/org/repo`). */
  repo: string;
  /** Git ref to check out: a tag, branch, or commit SHA. */
  "repo-ref": string;
  /** Whether plugins live at the repository root rather than in a workspace subdirectory. */
  "repo-flat": boolean;
  /** Backstage version the source is compatible with. */
  "repo-backstage-version": string;
}

type TypeMap = {
  string: string;
  boolean: boolean;
};

function hasOwn<T extends object, K extends PropertyKey>(
  obj: T,
  key: K,
): obj is T & Record<K, unknown> {
  return key in obj;
}

function hasType<T extends keyof TypeMap>(value: unknown, expected: T): value is TypeMap[T] {
  return typeof value === expected;
}

function requireField<T extends keyof TypeMap>(obj: object, key: string, expected: T): TypeMap[T] {
  if (!hasOwn(obj, key)) {
    throw new Error(`Missing required field "${key}"`);
  }

  const value = obj[key];

  if (!hasType(value, expected)) {
    throw new Error(`Field "${key}" must be a ${expected}, got ${typeof value}`);
  }

  return value;
}

function parseSource(value: unknown): SourceJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }

  return {
    repo: requireField(value, "repo", "string"),
    "repo-ref": requireField(value, "repo-ref", "string"),
    "repo-flat": requireField(value, "repo-flat", "boolean"),
    "repo-backstage-version": requireField(value, "repo-backstage-version", "string"),
  };
}

/**
 * Read and validate a `source.json` file.
 *
 * @param filePath - Absolute path to the `source.json` file.
 * @throws If the file is missing, contains invalid JSON, or does not match
 *   the expected {@link SourceJson} schema.
 */
export function readSourceFile(filePath: string): SourceJson {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Failed to load '${filePath}': file not found`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`Failed to load '${filePath}': invalid JSON`, { cause });
  }

  try {
    return parseSource(raw);
  } catch (cause) {
    throw new Error(`Failed to load '${filePath}'`, { cause });
  }
}
