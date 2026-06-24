import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// For the GitHub Pages deploy (GITHUB_PAGES=1) we build only the self-contained
// "SWF Studio" pages (they compile + play SWFs in-browser, no server assets) and
// serve them under the project base path. A normal `vite build` is unchanged
// (builds the dev lab at index.html).
const pages = !!process.env.GITHUB_PAGES;

export default defineConfig({
  plugins: [react()],
  base: pages ? "/mmTour/" : "/",
  server: {
    fs: {
      strict: false,
    },
  },
  build: pages
    ? {
        rollupOptions: {
          input: {
            "convert-play": fileURLToPath(new URL("./convert-play.html", import.meta.url)),
          },
        },
      }
    : {},
});
