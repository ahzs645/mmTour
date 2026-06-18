// Cross-level "content title" lift.
//
// The player stacks each Flash `_levelN` movie on its own CSS layer (`.player-level`,
// z-index = level), which mirrors Flash level ordering: a higher level always paints over a
// lower one, and — like CSS stacking contexts — a child of the lower layer can never rise above
// the upper layer no matter its own z-index. That's correct for almost everything, but it loses
// one case Ruffle shows: a segment's sub-section TITLE (a `loadVariables`-bound text on `_level4`)
// sitting at the bottom, fully covered by the nav's opaque toolbar bar on `_level6`. The title is
// rendered at full opacity; it's just painted under the bar.
//
// This mirrors exactly that case — and only that case — into a top overlay above every level, so
// the covered title shows through. It is data-driven: the trigger is purely the live geometry
// (a TEXT leaf on level N fully contained by an OPAQUE node on a higher level), never a scene
// name, character id, frame, or position. Same-level occlusion is left alone (that's intentional
// Flash compositing); only the cross-level multi-SWF artifact is corrected.

type Box = {
  el: HTMLElement;
  level: number;
  isText: boolean;
  opaque: boolean;
  left: number; top: number; right: number; bottom: number;
};

function classify(el: HTMLElement, stage: DOMRect): Box {
  const level = Number(el.closest<HTMLElement>(".player-level")?.style.zIndex ?? "0");
  const media = el.querySelector<HTMLElement>(".player-media") ?? (el.firstElementChild as HTMLElement | null);
  const isText = Boolean(media?.classList.contains("player-text"));
  const isHit = Boolean(media?.classList.contains("player-hit"));
  const r = (media ?? el).getBoundingClientRect();
  const w = r.width, h = r.height;
  // A near-full-stage node is almost always a transparent SVG overlay (it draws only a few shapes),
  // so it overlaps everything geometrically without visually covering it — never treat it as opaque.
  const fullStage = w >= stage.width * 0.95 && h >= stage.height * 0.95;
  const opaque = !isText && !isHit && !fullStage && w > 0 && h > 0 && Number(getComputedStyle(el).opacity) > 0.9;
  return { el, level, isText, opaque, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

const contains = (outer: Box, inner: Box) =>
  outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;

/**
 * Start mirroring cross-level-covered content text into a top overlay. Returns a teardown fn.
 * Runs on a slow rAF (content titles don't move fast); does nothing when no player nodes exist.
 */
export function createOcclusionLift(playerLayer: HTMLElement): () => void {
  const overlay = document.createElement("div");
  overlay.className = "player-lift-overlay";
  overlay.setAttribute("aria-hidden", "true");
  // Mount on the stage (playerLayer's parent), NOT playerLayer itself — the controller
  // `replaceChildren()`s playerLayer on deactivate/reload, which would wipe the overlay. The
  // stage shares the same origin/scale context, so cloned-in transforms still land correctly.
  (playerLayer.parentElement ?? playerLayer).append(overlay);

  const clones = new Map<string, HTMLElement>();
  let raf = 0;
  let last = 0;

  const sync = () => {
    const stage = playerLayer.getBoundingClientRect();
    const boxes = [...playerLayer.querySelectorAll<HTMLElement>(".player-level .player-instance")].map((el) => classify(el, stage));
    const seen = new Set<string>();

    for (const text of boxes) {
      if (!text.isText || text.right <= text.left) continue;
      const coveredByUpper = boxes.some((o) => o.opaque && o.level > text.level && contains(o, text));
      if (!coveredByUpper) continue;
      const key = text.el.dataset.key;
      if (!key) continue;
      seen.add(key);

      let clone = clones.get(key);
      if (!clone) {
        clone = text.el.cloneNode(true) as HTMLElement;
        clone.removeAttribute("data-key"); // not owned by any level's DomRenderer
        overlay.append(clone);
        clones.set(key, clone);
      }
      // Keep the mirror in lockstep with the live node (position via the same transform, content).
      clone.style.transform = text.el.style.transform;
      clone.style.zIndex = text.el.style.zIndex;
      if (clone.innerHTML !== text.el.innerHTML) clone.innerHTML = text.el.innerHTML;
    }

    for (const [key, clone] of [...clones]) {
      if (!seen.has(key)) { clone.remove(); clones.delete(key); }
    }
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < 60) return; // ~16 Hz is plenty for a static title
    last = now;
    sync();
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    overlay.remove();
    clones.clear();
  };
}
