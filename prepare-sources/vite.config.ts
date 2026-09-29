import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    // Prefer explicit checks over `!`, which bypasses the type checker
    // and turns missing values into late crashes.
    rules: {
      "typescript/no-non-null-assertion": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    coverage: {
      enabled: true,
      exclude: ["lib/test-utils.ts"],
      thresholds: {
        100: true,
      },
    },
  },
});
