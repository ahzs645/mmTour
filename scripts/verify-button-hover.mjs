import { chromium } from "playwright";
const URL = process.env.APP_URL ?? "http://127.0.0.1:5174/";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on("pageerror", e => errors.push(String(e)));
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.waitForSelector("#renderMode");
await p.selectOption("#sceneSelect", { label: "Segment 1 - segment1.swf" }).catch(()=>{});
await p.waitForTimeout(1200);
await p.selectOption("#renderMode", "player");
await p.waitForTimeout(300);

const max = Number(await p.getAttribute("#frameScrubber", "max"));
let found = null;
for (let f = 0; f <= max; f += 1) {
  await p.$eval("#frameScrubber", (el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", {bubbles:true})); }, f);
  await p.waitForTimeout(40);
  const counts = await p.evaluate(() => ({
    inline: document.querySelectorAll("#playerLayer .player-sprite-inline svg").length,
    rects: document.querySelectorAll("#playerLayer .player-button-overlays rect").length,
  }));
  if (counts.rects > 0) { found = { frame: f, ...counts }; break; }
}

let hover = null;
if (found) {
  const box = await p.$eval("#playerLayer .player-button-overlays rect", (r) => {
    const b = r.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 };
  });
  const before = await p.evaluate(() => document.querySelectorAll("#playerLayer .player-button-overlays image").length);
  await p.mouse.move(box.x, box.y);
  await p.waitForTimeout(150);
  const afterHover = await p.evaluate(() => document.querySelectorAll("#playerLayer .player-button-overlays image").length);
  await p.mouse.down(); await p.waitForTimeout(80);
  const afterDown = await p.evaluate(() => document.querySelectorAll("#playerLayer .player-button-overlays image").length);
  await p.mouse.up();
  hover = { before, afterHover, afterDown };
}

console.log(JSON.stringify({ max, found, hover, errors: errors.slice(0,5) }, null, 2));
await b.close();
if (!found) { console.error("FAIL: no button overlays found on any frame"); process.exit(1); }
if (!hover || hover.afterHover <= hover.before) { console.error("FAIL: hover did not add over-state artwork"); process.exit(1); }
console.log("OK");
