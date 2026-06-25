// Ruffle reference-player loading for the side-by-side comparison.

import { state as appState } from "./state";
import { ruffleMount } from "./dom";
import type { TourScene } from "../data/scenes";

export async function loadRuffle(scene: TourScene) {
  await waitForRuffle();
  appState.rufflePlayer = window.RufflePlayer!.newest().createPlayer();
  appState.rufflePlayer.classList.add("ruffle-player");
  appState.rufflePlayer.setAttribute("width", "640");
  appState.rufflePlayer.setAttribute("height", "480");
  ruffleMount.replaceChildren(appState.rufflePlayer);
  const url = scene.ruffleUrl ?? `/${scene.swf}`;
  if (appState.rufflePlayer.ruffle) {
    await appState.rufflePlayer.ruffle().load({ url });
  } else if (appState.rufflePlayer.load) {
    await appState.rufflePlayer.load({ url });
  } else {
    throw new Error("Ruffle player exposes no load API");
  }
}

export async function waitForRuffle() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (window.RufflePlayer) return;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  throw new Error("Ruffle did not load");
}
