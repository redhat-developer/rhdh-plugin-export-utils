export type NpmPackageMetadata = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, Record<string, unknown>>;
  bin?: Record<string, string> | string;
};

const npmMetadataCache = new Map<string, NpmPackageMetadata | null>();
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch package metadata from the npm registry for an exact version.
 * Retries transient failures; negative-caches permanent 404s.
 */
export async function fetchNpmPackageMetadata(
  packageName: string,
  version: string,
  log: (message: string) => void,
): Promise<NpmPackageMetadata | null> {
  const cacheKey = `${packageName}@${version}`;
  if (npmMetadataCache.has(cacheKey)) {
    return npmMetadataCache.get(cacheKey) ?? null;
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);
      if (response.status >= 400) {
        const isTransient = response.status === 429 || response.status >= 500;
        if (isTransient && attempt < MAX_RETRIES) {
          const delayMs = INITIAL_DELAY_MS * 2 ** (attempt - 1);
          log(
            `npm fetch attempt ${attempt}/${MAX_RETRIES} got HTTP ${response.status} for ${packageName}@${version}, retrying in ${delayMs}ms`,
          );
          await sleep(delayMs);
          continue;
        }
        if (!isTransient) {
          log(`npm registry returned HTTP ${response.status} for ${packageName}@${version}`);
          npmMetadataCache.set(cacheKey, null);
        }
        return null;
      }

      const parsed = await response.json();
      if (typeof parsed !== "object" || parsed === null || parsed.error) {
        log(`npm registry returned error for ${packageName}@${version}`);
        npmMetadataCache.set(cacheKey, null);
        return null;
      }

      npmMetadataCache.set(cacheKey, parsed);
      return parsed;
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        const delayMs = INITIAL_DELAY_MS * 2 ** (attempt - 1);
        log(
          `npm fetch attempt ${attempt}/${MAX_RETRIES} failed for ${packageName}@${version}: ${String(error)}`,
        );
        await sleep(delayMs);
        continue;
      }
      log(
        `could not fetch npm metadata for ${packageName}@${version} after ${MAX_RETRIES} attempts`,
      );
      return null;
    }
  }

  return null;
}

/** Clear the in-memory npm metadata cache (for tests). */
export function clearNpmMetadataCache(): void {
  npmMetadataCache.clear();
}
