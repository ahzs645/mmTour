// Browser demo for the pure-TS SWF converter. Drop a .swf → parse + convert
// every asset client-side and render the results. No Java, no server.

import { parseSwf, swf } from "swf-parser";
import {
  collectShapes, defineShapeToSvg,
  collectBitmaps, bitmapToDataUrl,
  collectFonts, buildTtf,
  collectSounds, soundToDataUrl,
  collectButtons, composeButton,
  collectStaticTexts, fontsById, reconstructText,
} from "./index.ts";

const $ = (sel: string) => document.querySelector(sel)!;
const drop = $("#drop") as HTMLDivElement;
const fileInput = $("#file") as HTMLInputElement;
const statusEl = $("#status") as HTMLDivElement;
const out = $("#out") as HTMLDivElement;

// Sample buttons for the bundled tour scenes (served from /public).
const SAMPLES = ["A-tour", "intro", "nav", "segment1", "segment4", "segment5"];
const samplesEl = $("#samples") as HTMLDivElement;
for (const name of SAMPLES) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = async () => {
    try {
      setStatus(`Fetching ${name}.swf…`);
      const bytes = new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}${name}.swf`)).arrayBuffer());
      await convert(bytes, `${name}.swf`);
    } catch (e) {
      setStatus(`Couldn't load ${name}.swf (${(e as Error).message})`, "err");
    }
  };
  samplesEl.appendChild(b);
}

drop.onclick = (e) => { if ((e.target as HTMLElement).tagName !== "BUTTON") fileInput.click(); };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = async (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  const f = e.dataTransfer?.files?.[0];
  if (f) await readFile(f);
};
fileInput.onchange = async () => { if (fileInput.files?.[0]) await readFile(fileInput.files[0]); };

async function readFile(f: File) {
  await convert(new Uint8Array(await f.arrayBuffer()), f.name);
}

function setStatus(msg: string, cls = "") {
  statusEl.innerHTML = `<span class="${cls}">${msg}</span>`;
}

function section(title: string, count: number) {
  const s = document.createElement("section");
  s.innerHTML = `<h2>${title} <em>${count}</em></h2>`;
  out.appendChild(s);
  return s;
}

async function convert(bytes: Uint8Array, name: string) {
  out.innerHTML = "";
  setStatus(`Parsing ${name}…`);
  const t0 = performance.now();

  let movie: any;
  try {
    movie = parseSwf(bytes);
  } catch (e) {
    setStatus(`Parse failed: ${(e as Error).message}`, "err");
    return;
  }

  // header stats
  const fr = movie.header.frameSize;
  const counts: Record<string, number> = {};
  for (const t of movie.tags) {
    const n = (swf.TagType as any)[t.type] ?? t.type;
    counts[n] = (counts[n] ?? 0) + 1;
  }
  const stats = document.createElement("div");
  stats.className = "stats";
  const stat = (b: string | number, s: string) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
  stats.innerHTML =
    stat(`${Math.round((fr.xMax - fr.xMin) / 20)}×${Math.round((fr.yMax - fr.yMin) / 20)}`, "stage px") +
    stat(movie.header.frameCount, "frames") +
    stat((movie.header.frameRate?.epsilons ? movie.header.frameRate.epsilons / 256 : movie.header.frameRate) + " fps", "rate") +
    stat(movie.tags.length, "tags");
  out.appendChild(stats);

  // run each converter, isolated so one failure doesn't sink the page
  await renderShapes(bytes);
  await renderImages(movie);
  renderFonts(movie);
  renderSounds(movie);
  renderButtons(movie);
  renderTexts(movie);

  setStatus(`✓ Converted ${name} in ${Math.round(performance.now() - t0)} ms — all client-side, no Java.`, "ok");
}

async function renderShapes(bytes: Uint8Array) {
  const { shapes } = collectShapes(bytes);
  const s = section("Shapes → SVG", shapes.length);
  const grid = el("div", "grid");
  for (const { id, tag } of shapes.slice(0, 120)) {
    try {
      const { svg } = defineShapeToSvg(tag);
      grid.appendChild(cell(svg, id, true));
    } catch { /* skip a bad shape */ }
  }
  s.appendChild(grid);
  if (shapes.length > 120) s.appendChild(note(`+${shapes.length - 120} more`));
}

async function renderImages(movie: any) {
  const { bitmaps, jpegTables } = collectBitmaps(movie);
  const s = section("Images → PNG / JPEG", bitmaps.length);
  const grid = el("div", "grid");
  s.appendChild(grid);
  for (const tag of bitmaps) {
    try {
      const { dataUrl } = await bitmapToDataUrl(tag, jpegTables);
      const img = document.createElement("img");
      img.src = dataUrl;
      grid.appendChild(cell(img, tag.id, true));
    } catch (e) {
      grid.appendChild(cell(`<small>${(e as Error).message}</small>`, tag.id));
    }
  }
}

function renderFonts(movie: any) {
  const fonts = collectFonts(movie);
  const s = section("Fonts → TTF", fonts.length);
  const wrap = el("div", "fonts");
  for (const font of fonts) {
    try {
      const ttf = buildTtf(font);
      const family = `swf-demo-${font.id}`;
      const face = new FontFace(family, ttf.buffer as ArrayBuffer);
      face.load().then((f) => (document.fonts as any).add(f));
      const row = el("div", "row");
      row.innerHTML = `<span class="name">${font.fontName} <span class="pill">#${font.id} · ${font.glyphs.length} glyphs</span></span>` +
        `<span class="sample" style="font-family:'${family}',serif">The quick brown fox 0123</span>`;
      wrap.appendChild(row);
    } catch { /* skip */ }
  }
  s.appendChild(wrap);
}

function renderSounds(movie: any) {
  const sounds = collectSounds(movie);
  const s = section("Sounds → MP3 / WAV", sounds.length);
  const wrap = el("div", "sounds");
  for (const tag of sounds) {
    try {
      const { dataUrl, mime } = soundToDataUrl(tag);
      const row = el("div", "row");
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.src = dataUrl;
      row.innerHTML = `<span class="pill">#${tag.id} · ${mime}</span>`;
      row.appendChild(audio);
      wrap.appendChild(row);
    } catch { /* skip */ }
  }
  s.appendChild(wrap);
}

function renderButtons(movie: any) {
  const buttons = collectButtons(movie);
  const shapesById = new Map<number, any>();
  for (const t of movie.tags) if (t.type === swf.TagType.DefineShape) shapesById.set(t.id, t);
  const s = section("Buttons → SVG (up state)", buttons.length);
  const grid = el("div", "grid");
  for (const button of buttons) {
    try {
      const composed = composeButton(button, (id) => shapesById.get(id));
      const up = composed.states["1_up"] ?? composed.states["4_hittest"];
      if (up && /<path|<image|<use/.test(up)) grid.appendChild(cell(up, button.id, true));
    } catch { /* skip */ }
  }
  s.appendChild(grid);
}

function renderTexts(movie: any) {
  const fonts = fontsById(movie);
  const statics = collectStaticTexts(movie).map((t) => ({ id: t.id, text: reconstructText(t, fonts) }));
  const edits = movie.tags
    .filter((t: any) => t.type === swf.TagType.DefineDynamicText && t.text)
    .map((t: any) => ({ id: t.id, text: String(t.text) }));
  const all = [...statics, ...edits].filter((x) => x.text.trim());
  const s = section("Text reconstructed", all.length);
  const wrap = el("div", "texts");
  for (const { id, text } of all.slice(0, 60)) {
    const row = el("div", "row");
    row.innerHTML = `<span class="tid">#${id}</span><span>${escapeHtml(text).slice(0, 200)}</span>`;
    wrap.appendChild(row);
  }
  s.appendChild(wrap);
}

// --- tiny DOM helpers ---
function el(tag: string, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function cell(content: string | HTMLElement, id: number, checker = false) {
  const c = el("div", "cell" + (checker ? " checker" : ""));
  if (typeof content === "string") c.innerHTML = content;
  else c.appendChild(content);
  const tag = document.createElement("span");
  tag.className = "id";
  tag.textContent = `#${id}`;
  c.appendChild(tag);
  return c;
}
function note(text: string) {
  const n = el("div", "samples");
  n.textContent = text;
  return n;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
