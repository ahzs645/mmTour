/** DOM media element creation for scene tracks (shape/image/sprite/text/button). */

import type { GsapSceneTrack } from "./types";

export function createTrackElement(track: GsapSceneTrack): { element: HTMLDivElement; media: HTMLElement } {
  const element = document.createElement("div");
  element.className = "gsap-scene-track";
  element.dataset.depth = String(track.depth);
  element.dataset.characterId = String(track.characterId);
  element.dataset.kind = track.kind;
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.transformOrigin = "0 0";
  element.style.zIndex = String(track.depth);
  element.style.display = "none";
  element.style.pointerEvents = track.release ? "auto" : "none";
  if (track.release) element.style.cursor = "pointer";

  const media = createMedia(track);
  element.append(media);
  return { element, media };
}

function createMedia(track: GsapSceneTrack): HTMLElement {
  const origin = track.origin;
  if (track.kind === "text") {
    const text = document.createElement("div");
    text.className = "gsap-scene-media gsap-scene-text";
    text.style.position = "absolute";
    text.style.left = `${-origin.x}px`;
    text.style.top = `${-origin.y}px`;
    if (origin.width) text.style.width = `${origin.width}px`;
    if (track.textSrc) {
      void fetch(`/${track.textSrc}`)
        .then((response) => (response.ok ? response.text() : ""))
        .then((content) => { text.textContent = content.trim(); });
    }
    return text;
  }

  const image = document.createElement("img");
  image.className = "gsap-scene-media";
  image.decoding = "async";
  image.draggable = false;
  image.style.position = "absolute";
  image.style.left = `${-origin.x}px`;
  image.style.top = `${-origin.y}px`;
  if (origin.width) image.style.width = `${origin.width}px`;
  if (origin.height) image.style.height = `${origin.height}px`;
  const initialSrc = track.src ?? track.cells?.[0]?.src ?? "";
  if (initialSrc) {
    image.src = `/${initialSrc}`;
    image.dataset.src = initialSrc;
  }
  return image;
}
