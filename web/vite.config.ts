import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("../dist/web", import.meta.url));

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    cors: true,
  },
  build: {
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".css") ? "assets/app.css" : "assets/[name][extname]",
      },
    },
  },
});
