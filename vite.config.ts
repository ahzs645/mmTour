import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    fs: {
      strict: false,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        scenePlayer: resolve(__dirname, "scene-player.html"),
      },
    },
  },
});
