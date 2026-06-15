import { assetUrl } from "../data/TimelineLoader";
import type { AssetTimeline, ControlAction } from "../data/timelineTypes";
import { ffdecCharacterId, matrixToSvg, walkVisibleSvgTree } from "./svgUtils";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

export type ButtonDispatch = (action: ControlAction) => void;

/**
 * Locate button artwork inside an inline sprite SVG and overlay transparent,
 * interactive hit rectangles. Hovering swaps in the button's over/down state
 * artwork (keyed `button:<id>`); releasing dispatches its release action.
 * Returns the number of buttons wired.
 */
export function installButtonOverlays(svg: SVGSVGElement, timeline: AssetTimeline, dispatch: ButtonDispatch): number {
  const buttonActions = timeline.control?.buttonActions;
  if (!buttonActions) return 0;

  const root = [...svg.children].find((child) => child.tagName.toLowerCase() === "g") as SVGGElement | undefined;
  if (!root) return 0;

  const overlayLayer = document.createElementNS(SVG_NS, "g");
  overlayLayer.setAttribute("class", "player-button-overlays");
  svg.append(overlayLayer);

  let count = 0;
  walkVisibleSvgTree(root, new DOMMatrix(), (element, matrix) => {
    const characterId = ffdecCharacterId(element);
    if (!characterId || !buttonActions[characterId]) return;

    const width = Number.parseFloat(element.getAttribute("width") ?? "0");
    const height = Number.parseFloat(element.getAttribute("height") ?? "0");
    if (width <= 0 || height <= 0) return;

    const release = buttonActions[characterId].release;
    let stateImage: SVGImageElement | null = null;

    const clearState = () => {
      stateImage?.remove();
      stateImage = null;
    };

    const showState = (state: "over" | "down") => {
      clearState();
      const asset = timeline.assets[`button:${characterId}`];
      const stateAsset = asset?.states?.[state] ?? asset?.states?.up;
      if (!stateAsset || stateAsset.origin.width <= 0 || stateAsset.origin.height <= 0) return;
      const image = document.createElementNS(SVG_NS, "image");
      image.setAttribute("href", assetUrl(stateAsset.src));
      image.setAttributeNS(XLINK_NS, "href", assetUrl(stateAsset.src));
      image.setAttribute("x", String(-stateAsset.origin.x));
      image.setAttribute("y", String(-stateAsset.origin.y));
      image.setAttribute("width", String(stateAsset.origin.width));
      image.setAttribute("height", String(stateAsset.origin.height));
      image.setAttribute("transform", matrixToSvg(matrix));
      image.style.pointerEvents = "none";
      overlayLayer.insertBefore(image, hit);
      stateImage = image;
    };

    const hit = document.createElementNS(SVG_NS, "rect");
    hit.setAttribute("x", "0");
    hit.setAttribute("y", "0");
    hit.setAttribute("width", String(width));
    hit.setAttribute("height", String(height));
    hit.setAttribute("transform", matrixToSvg(matrix));
    hit.setAttribute("fill", "transparent");
    hit.style.cursor = "pointer";
    hit.style.pointerEvents = "auto";

    hit.addEventListener("pointerenter", () => showState("over"));
    hit.addEventListener("pointerleave", clearState);
    hit.addEventListener("pointerdown", () => showState("down"));
    hit.addEventListener("pointerup", () => {
      showState("over");
      if (release) dispatch(release);
    });

    overlayLayer.append(hit);
    count += 1;
  });

  return count;
}
