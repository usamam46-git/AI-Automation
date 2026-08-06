import { defineConfig } from "vitest/config";

/**
 * Unit tests cover the pure modules under `lib/` that carry real correctness
 * risk — graph validation (duplicated from the backend), graph mapping
 * (round-trip fidelity), and output-schema emit (strict-mode rules).
 *
 * Canvas drag/drop, panel rendering and React Flow theming are deliberately NOT
 * covered here: interaction tests for them cost more than they would catch, and
 * are verified manually in the browser instead.
 */
export default defineConfig({
  resolve: {
    alias: { "@": import.meta.dirname },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
