import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts", "web/src/**/*.test.tsx"],
  },
});
