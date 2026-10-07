import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome150",
    assetsInlineLimit: 0,
  },
});
