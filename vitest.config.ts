import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["lib/**/*.ts"],
      exclude: ["**/*.test.ts", "**/types.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // server-only's real index.js throws when not imported from RSC build;
      // tests run in plain Node, so swap it for a no-op stub.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
