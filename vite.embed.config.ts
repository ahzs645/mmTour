import { defineConfig } from "vite";
import { resolve } from "node:path";

// Self-contained embed build: the tour player bundled WITH gsap (unlike the npm
// library build in vite.lib.config.ts, which leaves gsap external for consumers to
// dedupe). Produces a single ESM file other webapps can drop in with no bundler and
// no peer dependency — pair it with xp-tour.pack and the emitted CSS. See
// `scripts/build-embed.mjs`, which assembles dist-embed/ around this output.
export default defineConfig({
  build: {
    outDir: "dist-embed",
    emptyOutDir: true,
    sourcemap: false,
    copyPublicDir: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "mmtour-player.js",
      cssFileName: "mmtour-player",
    },
    // gsap is intentionally bundled (not external) so the embed is drop-in.
  },
});
