/**
 * Check whether a resolved version satisfies a caret (^) or tilde (~) range.
 * Handles common semver cases without an external library.
 */
export function caretOrTildeSatisfies(
  resolved: string,
  prefix: "^" | "~",
  rangeVersion: string,
): boolean {
  const rParts = resolved.split(".").map(Number);
  const sParts = rangeVersion.split(".").map(Number);

  const rMaj = rParts[0];
  const rMin = rParts[1];
  const rPatch = rParts[2];
  const sMaj = sParts[0];
  const sMin = sParts[1];
  const sPatch = sParts[2];
  if (
    rMaj === undefined ||
    rMin === undefined ||
    rPatch === undefined ||
    sMaj === undefined ||
    sMin === undefined ||
    sPatch === undefined
  ) {
    return false;
  }

  if (prefix === "~") {
    return rMaj === sMaj && rMin === sMin && rPatch >= sPatch;
  }

  if (rMaj !== sMaj) return false;
  if (sMaj > 0) {
    return rMin > sMin || (rMin === sMin && rPatch >= sPatch);
  }
  if (sMin > 0) {
    return rMin === sMin && rPatch >= sPatch;
  }
  return rPatch === sPatch;
}
