/**
 * Type guard: non-null `object` that is not an array.
 * @returns Narrows to `Record<string, unknown>`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
