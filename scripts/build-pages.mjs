#!/usr/bin/env node
// GitHub Pages build: the in-browser SWF Studio (convert + play + export an
// embeddable pack) AND the embed player runtime, served from one site.
//
//   dist/index.html          the Studio (copied from convert-play.html)
//   dist/convert-play.html
//   dist/assets/*            Studio bundle
//   dist/mmtour-player.js    embed runtime (player + gsap) the export snippet points at
//   dist/mmtour-player.css
//
// So a visitor converts their SWFs here, downloads <name>.mmtour.pack, hosts it, and
// embeds it with the player this site already serves. Run: npm run build:pages
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const vite = join(root, "node_modules/.bin/vite");
const run = (args, env) => execFileSync(vite, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

console.log("Building the SWF Studio (GitHub Pages)…");
run(["build"], { GITHUB_PAGES: "1" });

console.log("Building the embed player runtime…");
run(["build", "--config", "vite.embed.config.ts"]);

copyFileSync(join(root, "dist-embed/mmtour-player.js"), join(root, "dist/mmtour-player.js"));
copyFileSync(join(root, "dist-embed/mmtour-player.css"), join(root, "dist/mmtour-player.css"));
copyFileSync(join(root, "dist/convert-play.html"), join(root, "dist/index.html"));

console.log("\ndist/ ready: Studio at index.html, embed runtime at mmtour-player.js");
