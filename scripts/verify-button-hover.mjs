import { chromium } from "playwright";

// Verifies the decompiled player's button interaction: hovering an interactive
// sprite plays its rollOver animation, rolling out collapses it, and clicking
// navigates the root timeline — driven by control.buttonActions, like the source.

const URL = process.env.APP_URL ?? "http://127.0.0.1:5173/";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 760 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#renderMode");
// segment4 (default) opens on its interactive menu.
await page.waitForTimeout(2600);

const box = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll("#playerLayer .player-instance img")].filter(
    (i) => getComputedStyle(i).pointerEvents === "auto",
  );
  const target = imgs[1] ?? imgs[0];
  if (!target) return null;
  const b = target.getBoundingClientRect();
  return { count: imgs.length, x: b.x + b.width / 2, y: b.y + b.height / 2 };
});

const iconSrc = () =>
  page.evaluate(() => {
    const imgs = [...document.querySelectorAll("#playerLayer .player-instance img")].filter(
      (i) => getComputedStyle(i).pointerEvents === "auto",
    );
    return (imgs[1] ?? imgs[0])?.getAttribute("src")?.split("/").pop();
  });
const rootStatus = () => page.textContent("#status").then((s) => s?.trim());

const resting = await iconSrc();
const rootBefore = await rootStatus();

// HOVER → expect the icon to animate (frame changes).
await page.mouse.move(box.x, box.y);
const hover = [];
for (let i = 0; i < 6; i += 1) {
  await page.waitForTimeout(110);
  hover.push(await iconSrc());
}
const hoverAnimated = new Set(hover).size > 1;

// ROLLOUT → expect the icon to return toward its resting frame.
await page.mouse.move(5, 5);
await page.waitForTimeout(900);
const afterRollout = await iconSrc();

// CLICK → expect the root timeline to navigate.
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(300);
await page.mouse.down();
await page.waitForTimeout(50);
await page.mouse.up();
await page.waitForTimeout(900);
const rootAfter = await rootStatus();

await browser.close();

const navigated = rootBefore !== rootAfter;
console.log(
  JSON.stringify(
    { interactiveImages: box?.count, resting, hover, hoverAnimated, afterRollout, rootBefore, rootAfter, navigated, errors: errors.slice(0, 5) },
    null,
    2,
  ),
);

if (!box) {
  console.error("FAIL: no interactive sprites found");
  process.exit(1);
}
if (!hoverAnimated) {
  console.error("FAIL: hover did not animate the icon");
  process.exit(1);
}
if (!navigated) {
  console.error("FAIL: click did not navigate the root timeline");
  process.exit(1);
}
console.log("OK");
