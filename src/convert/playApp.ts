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

// --- convert + cards (laid out as a tree of linked scenes) ---
const cardEls = new Map<string, HTMLElement>();
const cardMeta = new Map<string, { name: string; compiled: CompiledScene }>();
const dependencyLoads = new Map<string, Promise<void>>();

/** Get (or create) the card element for a scene; a fresh one shows "converting…". */
function ensureCard(key: string, name: string): HTMLElement {
  let card = cardEls.get(key);
  if (!card) {
    card = document.createElement("div");
    card.className = "card busy";
    card.innerHTML = `<h3>${escapeHtml(name)}</h3><div class="meta">converting…</div>`;
    cardEls.set(key, card);
    layoutTree();
  }
  return card;
}

async function convertFile(name: string, bytes: Uint8Array) {
  const key = canonical(name);
  try {
    const compiled = await compile(bytes, name);
    await saveConvert({
      name, swf: new Blob([bytes.slice().buffer], { type: "application/x-shockwave-flash" }),
      stats: compiled.stats, width: compiled.width, height: compiled.height, createdAt: Date.now(),
    });
    renderHistory();
    await ensureDependencies(compiled); // recursively compile the whole linked tour
  } catch (e) {
    const card = cardEls.get(key);
    if (card) { card.classList.remove("busy"); card.innerHTML = `<h3>${escapeHtml(name)}</h3><div class="meta" style="color:#ff8a8a">convert failed: ${escapeHtml((e as Error).message)}</div>`; }
  }
}

/** Scene key a loadMovie("intro.swf") resolves to — basename, so cross-loads find it. */
const canonical = (name: string) => name.replace(/\.swf$/i, "").replace(/[^\w.-]+/g, "-");
const compiledScenes = new Map<string, CompiledScene>();
const inFlight = new Map<string, Promise<CompiledScene>>();

/** Compile a scene once (dedup by key — a batch drop AND cross-deps ask for the
 *  same scenes). Every compiled scene — dropped or auto-resolved dep — gets a
 *  card, so the tree shows the whole link graph. */
async function compile(bytes: Uint8Array, name: string): Promise<CompiledScene> {
  const scene = canonical(name);
  const done = compiledScenes.get(scene);
  if (done) return done;
  const running = inFlight.get(scene);
  if (running) return running;
  ensureCard(scene, name); // placeholder card shows immediately
  const promise = (async () => {
    const compiled = await compileSceneAsync(bytes, scene); // off the main thread → UI stays responsive
    registerPackedScene(scene, compiled.files, compiled.timeline);
    compiledScenes.set(scene, compiled);
    cardMeta.set(scene, { name, compiled });
    inFlight.delete(scene);
    renderCard(cardEls.get(scene)!, name, compiled);
    layoutTree();
    return compiled;
  })();
  inFlight.set(scene, promise);
  return promise;
}

/** Arrange the scene cards into a tree: roots (not loaded by anything — the
 *  A-tour shell) at top, each scene's loaded SWFs nested beneath it. Each scene
 *  shown once (deduped, cycle-safe). Card elements are reused across re-layout so
 *  in-progress state is preserved. */
function layoutTree() {
  const childOf = new Set<string>();
  for (const meta of cardMeta.values()) {
    for (const dep of meta.compiled.dependencies) { const ck = canonical(dep.swf); if (cardEls.has(ck)) childOf.add(ck); }
  }
  const roots = [...cardEls.keys()].filter((k) => !childOf.has(k));
  cards.innerHTML = "";
  const placed = new Set<string>();
  const renderNode = (key: string, container: HTMLElement) => {
    if (placed.has(key)) return;
    placed.add(key);
    const node = el("div", "node");
    node.appendChild(cardEls.get(key)!);
    const childKeys = unique((cardMeta.get(key)?.compiled.dependencies ?? [])
      .map((d) => canonical(d.swf)).filter((ck) => cardEls.has(ck)));
    if (childKeys.length) {
      const kids = el("div", "children");
      for (const ck of childKeys) {
        if (placed.has(ck)) renderReference(ck, kids);
        else renderNode(ck, kids);
      }
      if (kids.children.length) node.appendChild(kids);
    }
    container.appendChild(node);
  };
  for (const r of roots) renderNode(r, cards);
  for (const k of cardEls.keys()) renderNode(k, cards); // leftovers (pure cycles)
}

function renderReference(key: string, container: HTMLElement) {
  const ref = el("div", "ref-node");
  ref.innerHTML = `<span>↳ ${escapeHtml(sceneLabel(key))}</span><em>shown above</em>`;
  container.appendChild(ref);
}

function sceneLabel(key: string): string {
  return cardMeta.get(key)?.name ?? `${key}.swf`;
}

type DepStatus = "pending" | "compiling" | "linking" | "done" | "missing";

/** Recursively compile the whole linked tour. A shell (A-tour) loadMovie's other
 *  SWFs into levels, and those load yet others (nav→segments, segment1→2→3→5…) —
 *  so loading A-tour readies EVERY reachable scene, building out the tree. Each
 *  scene compiles once (dedup); its own card shows live per-link progress. */
function ensureDependencies(c: CompiledScene): Promise<void> {
  const running = dependencyLoads.get(c.scene);
  if (running) return running;
  const load = resolveDependencies(c, new Set([c.scene])).finally(() => dependencyLoads.delete(c.scene));
  dependencyLoads.set(c.scene, load);
  return load;
}

async function resolveDependencies(c: CompiledScene, visited = new Set<string>()): Promise<void> {
  if (!c.dependencies.length) return;
  const card = cardEls.get(c.scene);
  const state = new Map<string, DepStatus>(c.dependencies.map((d) => [d.swf, "pending"]));
  if (card) renderDeps(card, c, state);

  // Compile the scenes loaded AT STARTUP (intro/nav for A-tour) first, so the
  // shell is playable quickly; heavier on-click segments follow.
  const startup = new Set(startupSwfs(c).map((swf) => swf.toLowerCase()));
  const ordered = [...c.dependencies].sort((a, b) => (startup.has(b.swf.toLowerCase()) ? 1 : 0) - (startup.has(a.swf.toLowerCase()) ? 1 : 0));

  for (const dep of ordered) {
    const dk = canonical(dep.swf);
    if (!compiledScenes.has(dk)) {
      state.set(dep.swf, "compiling");
      if (card) renderDeps(card, c, state);
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}${dep.swf}`);
        if (!r.ok) throw new Error("not found");
        await compile(new Uint8Array(await r.arrayBuffer()), dep.swf);
      } catch { state.set(dep.swf, "missing"); if (card) renderDeps(card, c, state); continue; }
    }
    // recurse into the dep's own links (cycle-safe via `visited`)
    if (!visited.has(dk)) {
      visited.add(dk);
      const depScene = compiledScenes.get(dk);
      if (depScene?.dependencies.length) {
        state.set(dep.swf, "linking");
        if (card) renderDeps(card, c, state);
        await resolveDependencies(depScene, visited);
      }
    }
    state.set(dep.swf, "done");
    if (card) renderDeps(card, c, state);
  }
}

/** Render the dependency line with live per-SWF status pills + a progress count. */
function renderDeps(card: HTMLElement, c: CompiledScene, state: Map<string, DepStatus>) {
  const el = card.querySelector(".dep");
  if (!el) return;
  const total = c.dependencies.length;
  const finished = c.dependencies.filter((d) => { const s = state.get(d.swf); return s === "done" || s === "missing"; }).length;
  const active = c.dependencies.find((d) => {
    const s = state.get(d.swf);
    return s === "compiling" || s === "linking";
  });
  const activeState = active ? state.get(active.swf) : undefined;
  const activeLabel = activeState === "linking" ? `resolving ${escapeHtml(active!.swf)} links…` : active ? `compiling ${escapeHtml(active.swf)}…` : "";
  const head = finished < total
    ? `⟳ linking ${finished}/${total}${activeLabel ? ` · ${activeLabel}` : "…"} `
    : `links ${total} SWF${total > 1 ? "s" : ""}: `;
  const pills = c.dependencies.map((d) => {
    const s = state.get(d.swf) ?? "pending";
    const cls = s === "done" ? "ok" : s === "missing" ? "miss" : s === "compiling" || s === "linking" ? "go" : "pend";
    return `<span class="pill ${cls}">${escapeHtml(d.swf)}</span>`;
  }).join(" ");
  const tail = finished < total ? ""
    : [...state.values()].includes("missing") ? ` <span style="color:var(--warn)">— drop the missing ones</span>`
    : ` <span style="color:var(--accent-2)">— all compiled ✓</span>`;
  el.innerHTML = head + pills + tail;
}

function renderCard(card: HTMLElement, name: string, c: CompiledScene) {
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
  const dependencyLoad = ensureDependencies(c);
  registerPackedScene(scene, c.files, c.timeline); // ensure registered (after a prior close)
  playerWrap.classList.add("on");
  playerTitle.textContent = name;
  // Fit the stage to a target width and size the WRAP to the scaled stage, so the
  // wrap's backdrop never shows as a black band beside a 640px stage.
  const availableW = Math.max(1, playerWrap.parentElement?.clientWidth ?? c.width);
  const targetW = Math.min(820, availableW);
  const scale = targetW / c.width;
  const stageW = Math.round(c.width * scale);
  const stageH = Math.round(c.height * scale);
  playerEl.style.width = `${c.width}px`;
  playerEl.style.height = `${c.height}px`;
  playerEl.style.transform = `scale(${scale})`;
  playerEl.style.transformOrigin = "top left";
  playerEl.style.background = c.timeline.backgroundColor || "#ffffff";
  playerWrap.style.width = `${stageW}px`;
  playerWrap.style.height = `${stageH + 48}px`;
  playerWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // A shell loads other SWFs into levels at startup — wait for those to compile +
  // register first, else the levels load nothing and the stage looks empty.
  const startupDeps = startupDependencies(c).filter((dep) => !compiledScenes.has(canonical(dep.swf)));
  const waits = startupDeps.map((dep) => ensureDependencyCompiled(dep));
  if (waits.length) { playerTitle.textContent = `${name} — preparing ${waits.length} startup level${waits.length > 1 ? "s" : ""}…`; await Promise.all(waits); playerTitle.textContent = name; }
  void dependencyLoad;

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
  playerWrap.style.width = "";
  playerWrap.style.height = "";
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
    void ensureDependencies(compiled);
    await play(compiled.scene, compiled, full.name);
  };
  (row.querySelector(".dl") as HTMLButtonElement).onclick = async () => { await deleteConvert(rec.id!); renderHistory(); };
  return row;
}

// --- helpers ---
function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}
function toast(msg: string) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  setTimeout(() => t.classList.remove("on"), 2200);
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
function startupSwfs(c: CompiledScene): string[] {
  return unique((c.timeline.control?.frameActions ?? [])
    .flatMap((f: any) => f.actions ?? [])
    .filter((a: any) => a.swf && !a.functionName)
    .map((a: any) => String(a.swf)));
}
function startupDependencies(c: CompiledScene) {
  const startupKeys = new Set(startupSwfs(c).map((swf) => canonical(swf)));
  return c.dependencies.filter((dep) => startupKeys.has(canonical(dep.swf)));
}
async function ensureDependencyCompiled(dep: { swf: string }): Promise<CompiledScene | null> {
  const key = canonical(dep.swf);
  const done = compiledScenes.get(key);
  if (done) return done;
  const running = inFlight.get(key);
  if (running) return running;
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}${dep.swf}`);
    if (!r.ok) throw new Error("not found");
    return await compile(new Uint8Array(await r.arrayBuffer()), dep.swf);
  } catch {
    return null;
  }
}
function transparentPixel() {
  return "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}
