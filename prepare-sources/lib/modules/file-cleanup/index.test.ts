import { describe } from "vite-plus/test";

import { testInputOutputExpectations } from "../../test-utils.ts";
import { run } from "./index.ts";

/**
 * Fixture catalog (`__fixtures__/<name>/` — name doubles as the Vitest case title):
 *
 * - `removes-test-and-dev-files-from-surviving-plugins` — all removable dir names
 *   (`dev/`, `e2e-tests/`, `__tests__/`, `__mocks__/`), all test/spec file patterns
 *   (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`); production source,
 *   stories, and `*.mock.ts` kept
 * - `preserves-files-under-dist-dynamic-and-node-modules` — exclusion boundaries
 *   for dist-dynamic/ and node_modules/
 */
describe("file-cleanup", () => {
  testInputOutputExpectations(import.meta.dirname, run);
});
