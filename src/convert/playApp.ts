// SWF Studio — drop SWFs, convert in-browser, play in the GSAP runtime, and keep
// a persistent IndexedDB history. Ties the converter (compileScene) to the
// player (createTourPlayer via the in-memory pack source) and Dexie history.

import type { CompiledScene } from "./compileScene.ts";
import { compileSceneAsync } from "./compileClient.ts";
import { registerPackedScene, setAssetSource } from "../data/packedAssets.ts";
import { createTourPlayer, type TourPlayer } from "../index.ts";

// Serve assets from the in-memory pack source. Set it ONCE up front: switching
// the source later (createTourPlayer does this internally) clears registered
// scenes, which would wipe the bundle we just compiled.
setAssetSource("pack");
import { saveConvert, listConverts, getConvert, deleteConvert, clearHistory, type ConvertRecord } from "./historyDb.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const drop = $("#drop"), fileInput = $<HTMLInputElement>("#file"), cards = $("#cards"), hist = $("#hist");
const playerWrap = $("#player-wrap"), playerEl = $("#player"), playerTitle = $("#player-title");
const SAMPLES = ["A-tour", "intro", "nav", "segment1", "segment4", "segment5"];

let activePlayer: TourPlayer | null = null;

// --- bootstrap UI ---
const samplesEl = $("#samples");
for (const name of SAMPLES) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = async () => {
    try {
      const bytes = new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}${name}.swf`)).arrayBuffer());
      await convertFile(`${name}.swf`, bytes);
    } catch (e) { toast(`Couldn't load ${name}.swf`); }
  };
  samplesEl.appendChild(b);
}

drop.onclick = (e) => { if ((e.target as HTMLElement).tagName !== "BUTTON") fileInput.click(); };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = async (e) => {
  e.preventDefault(); drop.classList.remove("drag");
  for (const f of Array.from(e.dataTransfer?.files ?? [])) if (/\.swf$/i.test(f.name)) await convertFile(f.name, new Uint8Array(await f.arrayBuffer()));
};
fileInput.onchange = async () => {
  for (const f of Array.from(fileInput.files ?? [])) await convertFile(f.name, new Uint8Array(await f.arrayBuffer()));
  fileInput.value = "";
};

$("#btn-play").onclick = () => activePlayer?.toggle();
$("#btn-restart").onclick = () => activePlayer?.restart();
$("#btn-close").onclick = () => closePlayer();
$("#clear-hist").onclick = async () => { await clearHistory(); renderHistory(); toast("History cleared"); };

renderHistory();

// --- convert + card ---
async function convertFile(name: string, bytes: Uint8Array) {
  const card = document.createElement("div");
  card.className = "card busy";
  card.innerHTML = `<h3>${escapeHtml(name)}</h3><div class="meta">converting…</div>`;
  cards.prepend(card);
  try {
    const compiled = await compile(bytes, name);
    renderCard(card, name, compiled, bytes); // stats + Play immediately (main scene is playable now)
    await saveConvert({
      name, swf: new Blob([bytes.slice().buffer], { type: "application/x-shockwave-flash" }),
      stats: compiled.stats, width: compiled.width, height: compiled.height, createdAt: Date.now(),
    });
    renderHistory();
    if (compiled.dependencies.length) {
      const state = new Map<string, DepStatus>(compiled.dependencies.map((d) => [d.swf, "pending"]));
      renderDeps(card, compiled, state);
      await resolveDependencies(compiled, (swf, status) => { state.set(swf, status); renderDeps(card, compiled, state); });
    }
  } catch (e) {
    card.classList.remove("busy");
    card.innerHTML = `<h3>${escapeHtml(name)}</h3><div class="meta" style="color:#ff8a8a">convert failed: ${escapeHtml((e as Error).message)}</div>`;
  }
}

/** Scene key a loadMovie("intro.swf") resolves to — basename, so cross-loads find it. */
const canonical = (name: string) => name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-");
const compiledScenes = new Map<string, CompiledScene>();
const inFlight = new Map<string, Promise<CompiledScene>>();

/** Compile a scene once. Dropping a batch AND each scene's cross-deps both ask
 *  for the same scenes — dedup by scene key (return the cached result or share
 *  the in-flight compile) so nothing is converted twice. */
async function compile(bytes: Uint8Array, name: string): Promise<CompiledScene> {
  const scene = canonical(name);
  const done = compiledScenes.get(scene);
  if (done) return done;
  const running = inFlight.get(scene);
  if (running) return running;
  const promise = (async () => {
    const compiled = await compileSceneAsync(bytes, scene); // off the main thread → UI stays responsive
    registerPackedScene(scene, compiled.files, compiled.timeline);
    compiledScenes.set(scene, compiled);
    inFlight.delete(scene);
    return compiled;
  })();
  inFlight.set(scene, promise);
  return promise;
}

type DepStatus = "pending" | "compiling" | "done" | "missing";

/** A shell (A-tour) loadMovie's the other SWFs into levels — compile + register
 *  each so the cross-loads resolve. Pull from already-converted scenes first,
 *  else fetch a bundled SWF of that name. Reports each step so the card shows
 *  live progress (one dep compiled at a time in the worker). */
async function resolveDependencies(c: CompiledScene, onStep: (swf: string, status: DepStatus) => void): Promise<void> {
  // Compile the deps the scene loads AT STARTUP (intro/nav for A-tour) first, so
  // the shell becomes playable quickly; the heavier on-click segments follow.
  const startup = new Set(
    (c.timeline?.control?.frameActions ?? []).flatMap((f: any) => f.actions ?? []).filter((a: any) => a.swf).map((a: any) => String(a.swf).toLowerCase()),
  );
  const ordered = [...c.dependencies].sort((a, b) => (startup.has(b.swf.toLowerCase()) ? 1 : 0) - (startup.has(a.swf.toLowerCase()) ? 1 : 0));
  for (const dep of ordered) {
    if (compiledScenes.has(canonical(dep.swf))) { onStep(dep.swf, "done"); continue; }
    onStep(dep.swf, "compiling");
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}${dep.swf}`);
      if (!r.ok) throw new Error("not found");
      await compile(new Uint8Array(await r.arrayBuffer()), dep.swf);
      onStep(dep.swf, "done");
    } catch { onStep(dep.swf, "missing"); }
  }
}

/** Render the dependency line with live per-SWF status pills + a progress count. */
function renderDeps(card: HTMLElement, c: CompiledScene, state: Map<string, DepStatus>) {
  const el = card.querySelector(".dep");
  if (!el) return;
  const total = c.dependencies.length;
  const finished = c.dependencies.filter((d) => { const s = state.get(d.swf); return s === "done" || s === "missing"; }).length;
  const compiling = c.dependencies.find((d) => state.get(d.swf) === "compiling");
  const head = finished < total
    ? `⟳ linking ${finished}/${total}${compiling ? ` · compiling ${escapeHtml(compiling.swf)}…` : "…"} `
    : `links ${total} SWF${total > 1 ? "s" : ""}: `;
  const pills = c.dependencies.map((d) => {
    const s = state.get(d.swf) ?? "pending";
    const cls = s === "done" ? "ok" : s === "missing" ? "miss" : s === "compiling" ? "go" : "pend";
    return `<span class="pill ${cls}">${escapeHtml(d.swf)}</span>`;
  }).join(" ");
  const tail = finished < total ? ""
    : [...state.values()].includes("missing") ? ` <span style="color:var(--warn)">— drop the missing ones</span>`
    : ` <span style="color:var(--accent-2)">— all compiled ✓</span>`;
  el.innerHTML = head + pills + tail;
}

function renderCard(card: HTMLElement, name: string, c: CompiledScene, bytes: Uint8Array) {
  const s = c.stats;
  card.classList.remove("busy");
  const depPlaceholder = c.dependencies.length ? `<div class="meta dep">⟳ linking ${c.dependencies.length} SWFs…</div>` : "";
  card.innerHTML =
    `<h3>${escapeHtml(name)} <span class="dim">${c.width}×${c.height}</span></h3>` +
    `<div class="statgrid">` +
      stat(s.shapes, "shapes") + stat(s.images, "images") + stat(s.fonts, "fonts") +
      stat(s.sounds, "sounds") + stat(s.buttons, "buttons") + stat(s.texts, "texts") +
      stat(s.frames, "frames") + stat(s.sprites, "sprites") + stat(s.stopFrames, "stops") +
    `</div>` +
    `<div class="meta">${(s.assetBytes / 1024 / 1024).toFixed(2)} MB assets · compiled in ${s.ms} ms</div>` +
    depPlaceholder +
    `<button class="play">▶ Play</button>`;
  (card.querySelector(".play") as HTMLButtonElement).onclick = () => play(c.scene, c, name);
}

const stat = (n: number, label: string) => `<div><b>${n}</b><span>${label}</span></div>`;

// --- player ---
async function play(scene: string, c: CompiledScene, name: string) {
  closePlayer();
  registerPackedScene(scene, c.files, c.timeline); // ensure registered (after a prior close)
  playerWrap.classList.add("on");
  playerTitle.textContent = name;
  // size the stage to fit, preserving aspect
  const maxW = Math.min(760, playerWrap.clientWidth || 760);
  const scale = Math.min(1, maxW / c.width);
  playerEl.style.width = `${c.width}px`;
  playerEl.style.height = `${c.height}px`;
  playerEl.style.transform = `scale(${scale})`;
  playerEl.style.transformOrigin = "top left";
  playerWrap.style.height = `${Math.ceil(c.height * scale) + 48}px`;
  playerWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    activePlayer = await createTourPlayer(playerEl, { assetSource: "pack", scene, autoplay: true });
  } catch (e) {
    toast(`Play failed: ${(e as Error).message}`);
  }
}

function closePlayer() {
  activePlayer?.destroy();
  activePlayer = null;
  playerEl.innerHTML = "";
  playerEl.style.transform = "";
  playerWrap.classList.remove("on");
}

// --- history (IndexedDB via Dexie) ---
async function renderHistory() {
  const items = await listConverts();
  if (!items.length) { hist.innerHTML = `<div class="empty">No converts yet.</div>`; return; }
  hist.innerHTML = "";
  for (const rec of items) hist.appendChild(historyRow(rec));
}

function historyRow(rec: ConvertRecord): HTMLElement {
  const row = document.createElement("div");
  row.className = "hrow";
  const s = rec.stats;
  row.innerHTML =
    `<img src="${rec.thumb ?? transparentPixel()}" alt="">` +
    `<div class="info"><b>${escapeHtml(rec.name)}</b>` +
    `<span>${rec.width}×${rec.height} · ${s.shapes}sh ${s.images}img ${s.frames}fr · ${new Date(rec.createdAt).toLocaleString()}</span></div>` +
    `<div class="acts"><button class="rp">▶</button><button class="dl">⌫</button></div>`;
  (row.querySelector(".rp") as HTMLButtonElement).onclick = async () => {
    const full = await getConvert(rec.id!);
    if (!full) return;
    const bytes = new Uint8Array(await full.swf.arrayBuffer());
    const compiled = await compile(bytes, full.name);
    await play(compiled.scene, compiled, full.name);
  };
  (row.querySelector(".dl") as HTMLButtonElement).onclick = async () => { await deleteConvert(rec.id!); renderHistory(); };
  return row;
}

// --- helpers ---
function toast(msg: string) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2200);
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function transparentPixel() {
  return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}
