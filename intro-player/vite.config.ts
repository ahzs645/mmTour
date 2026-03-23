import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Copy Ruffle's WASM and JS worker files to the build output
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ruffle-rs/ruffle/*.wasm',
          dest: 'ruffle',
        },
        {
          src: 'node_modules/@ruffle-rs/ruffle/core.ruffle.*.js',
          dest: 'ruffle',
        },
      ],
    }),
  ],
})
