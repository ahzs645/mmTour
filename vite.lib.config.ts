import { defineConfig } from "vite";
import { resolve } from "node:path";

// Library build for the embeddable tour player (the runtime core under src/,
// surfaced via src/index.ts). The dev lab keeps using vite.config.ts. GSAP is
// left external so consumers dedupe their own copy.
export default defineConfig({
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    sourcemap: true,
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["gsap"],
    },
  },
});
