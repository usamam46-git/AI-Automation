import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Claude Code skill tooling — CommonJS Node scripts that are never
    // bundled into the app. They trip @typescript-eslint/no-require-imports, and
    // `npm run lint` (bare `eslint`) is what CI runs, so leaving them in fails
    // the build on files we do not own.
    ".claude/**",
  ]),
]);

export default eslintConfig;
