import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ig": fileURLToPath(new URL("./src/features/interview-gym", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
