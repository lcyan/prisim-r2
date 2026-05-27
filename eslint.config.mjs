import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    ".open-next/**",
    ".vercel/**",
    ".wrangler/**",
    "cloudflare-env.d.ts",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "playwright/.auth/**",
    "test-results/**",
    "next-env.d.ts",
    "node_modules/**",
    "components/ui/**",
    "components/charts/**",
    "hooks/use-mobile.ts",
  ]),
]);

export default eslintConfig;
