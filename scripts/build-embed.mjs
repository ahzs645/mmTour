#!/usr/bin/env node
// Assemble a self-contained, drop-in embed package under dist-embed/:
//
//   dist-embed/
//     mmtour-player.js     ESM bundle of the player WITH gsap (no peer dep)
//     mmtour-player.css    player styles
//     xp-tour.pack         the whole tour in one file (HTTP-range loadable)
//     embed.html           minimal working example
//     README.md            how to host it
//
// Run: npm run build:embed   (builds the JS via vite.embed.config.ts first, then
// copies the pack and writes the example). The pack itself comes from
// `npm run pack:tour` — this script fails loudly if it's missing.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const outDir = join(root, "dist-embed");
const pack = join(root, "public/generated-archive/xp-tour.pack");

if (!existsSync(pack)) {
  console.error("error: public/generated-archive/xp-tour.pack not found. Run `npm run pack:tour` first.");
  process.exit(1);
}

console.log("Building embed bundle (vite.embed.config.ts)…");
execFileSync("node_modules/.bin/vite", ["build", "--config", "vite.embed.config.ts"], { cwd: root, stdio: "inherit" });

mkdirSync(outDir, { recursive: true });
copyFileSync(pack, join(outDir, "xp-tour.pack"));
const packMiB = (statSync(pack).size / 1048576).toFixed(2);
writeFileSync(join(outDir, "embed.html"), embedHtml());
writeFileSync(join(outDir, "README.md"), readme(packMiB));

const jsMiB = (statSync(join(outDir, "mmtour-player.js")).size / 1048576).toFixed(2);
console.log(`\ndist-embed/ ready:`);
console.log(`  mmtour-player.js   ${jsMiB} MiB (player + gsap)`);
console.log(`  mmtour-player.css`);
console.log(`  xp-tour.pack       ${packMiB} MiB (whole tour)`);
console.log(`  embed.html         open over http:// to try it`);

function embedHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Windows XP Tour — embedded</title>
    <link rel="stylesheet" href="./mmtour-player.css" />
    <style>
      body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #1b3a6b; }
      /* The tour stage is authored at 640x480; scale the wrapper to taste. */
      #tour { width: 640px; height: 480px; position: relative; overflow: hidden; background: #000; }
    </style>
  </head>
  <body>
    <div id="tour"></div>
    <script type="module">
      import { createTourPlayer } from "./mmtour-player.js";
      // One file, loaded on demand via HTTP Range — host xp-tour.pack next to this page.
      const tour = await createTourPlayer(document.getElementById("tour"), {
        assetSource: "archive",
        archiveUrl: "./xp-tour.pack",
        autoplay: true,
      });
      // tour.pause(); tour.play(); tour.restart(); tour.destroy(); …
      window.__tour = tour;
    </script>
  </body>
</html>
`;
}

function readme(packMiB) {
  return `# Windows XP Tour — embed package

A self-contained build of the decompiled tour player plus the whole tour in one
file. Drop these into any web app and serve them over HTTP (the pack is read on
demand with HTTP Range requests, so \`file://\` will not work).

## Files

- \`mmtour-player.js\` — ESM bundle of the player, gsap included (no peer dependency).
- \`mmtour-player.css\` — player styles (link it in \`<head>\`).
- \`xp-tour.pack\` — all eight tour scenes + media in one file (~${packMiB} MiB).
- \`embed.html\` — a minimal working example.

## Use

\`\`\`html
<link rel="stylesheet" href="/path/to/mmtour-player.css" />
<div id="tour" style="width:640px;height:480px;position:relative;overflow:hidden"></div>
<script type="module">
  import { createTourPlayer } from "/path/to/mmtour-player.js";
  const tour = await createTourPlayer(document.getElementById("tour"), {
    assetSource: "archive",
    archiveUrl: "/path/to/xp-tour.pack",
    autoplay: true,
  });
</script>
\`\`\`

\`createTourPlayer\` returns a handle: \`play() pause() toggle() restart() seek(frame)
destroy()\` plus \`frameCount / currentFrame / isPlaying\`. The stage is authored at
640×480; scale its wrapper with CSS \`transform\` as needed.

## npm consumers

If your app uses a bundler, prefer the npm library build instead (gsap stays an
external peer dependency you dedupe): \`import { createTourPlayer } from
"windows-xp-tour-gsap"\`, install \`gsap\`, and host \`xp-tour.pack\` yourself.

## Regenerating the pack

\`npm run pack:tour\` (requires Java for the FFDec extraction step) rebuilds
\`xp-tour.pack\`; \`npm run build:embed\` reassembles this folder around it.
`;
}
