import { chromium } from "playwright";

// Verifies the nested-runtime section playback: from segment 4's menu, clicking a
// section icon navigates the root timeline, plays the transition, and reveals the
// section content (the "For more information / Click Start…" text) — like Ruffle.

const URL = process.env.APP_URL ?? "http://127.0.0.1:5173/";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 760 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#renderMode");
await page.waitForTimeout(2800); // segment 4 is the default scene → its menu

const buttons = await page.evaluate(() =>
  [...document.querySelectorAll("#playerLayer .player-media")]
    .filter((m) => getComputedStyle(m).pointerEvents === "auto")
    .map((m) => {
      const b = m.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }),
);

const rootBefore = (await page.textContent("#status"))?.trim();

if (buttons[0]) {
  await page.mouse.move(buttons[0].x, buttons[0].y);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
}

// Give the transition + section a few seconds to play through.
let sectionText = false;
let rootAfter = rootBefore;
for (let i = 0; i < 10 && !sectionText; i += 1) {
  await page.waitForTimeout(400);
  rootAfter = (await page.textContent("#status"))?.trim();
  sectionText = await page.evaluate(() =>
    [...document.querySelectorAll("#playerLayer .player-text")].some((t) => /Click Start|walkthrough|more information/i.test(t.textContent || "")),
  );
}

await browser.close();

const navigated = rootBefore !== rootAfter;
console.log(JSON.stringify({ buttonCount: buttons.length, rootBefore, rootAfter, navigated, sectionTextVisible: sectionText, errors: errors.slice(0, 5) }, null, 2));

if (!buttons.length) {
  console.error("FAIL: no interactive buttons on the menu");
  process.exit(1);
}
if (!navigated) {
  console.error("FAIL: clicking a section did not navigate the root");
  process.exit(1);
}
if (!sectionText) {
  console.error("FAIL: section content text never revealed");
  process.exit(1);
}
console.log("OK");
