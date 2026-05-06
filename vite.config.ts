import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: "src/renderer",
  // Relative asset paths so file:// loading from Electron works.
  // Default "/" makes script src absolute → Electron resolves at filesystem root → ENOENT.
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "src/renderer/index.html"),
        picker: path.resolve(__dirname, "src/renderer/picker.html"),
      },
    },
  },
});
