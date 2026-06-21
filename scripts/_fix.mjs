import { chromium } from "playwright"; import { resolve } from "node:path";
const root = resolve(new URL("..", import.meta.url).pathname);
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1100,height:900} });
await p.goto("http://127.0.0.1:5173/convert-play.html", { waitUntil:"load", timeout: 30000 });
await p.getByRole("button",{name:"A-tour",exact:true}).click();
// recursive: tree should grow past the 4 direct deps (segment1/2/3 nest in too)
await p.waitForFunction(()=>document.querySelectorAll(".node").length>=7, {timeout:120000}).catch(()=>{});
const nodes = await p.locator(".node").count();
// play A-tour, check wrap fits stage (no black band)
await p.waitForFunction(()=>{const pills=[...document.querySelectorAll(".card .pill")]; const i=pills.find(x=>x.textContent.includes("intro")); const n=pills.find(x=>x.textContent.includes("nav")); return i?.classList.contains("ok")&&n?.classList.contains("ok");},{timeout:30000});
await p.locator(".card",{has:p.locator("h3",{hasText:"A-tour.swf"})}).first().locator(".play").click();
await p.waitForTimeout(7000);
const fit = await p.evaluate(()=>{const w=document.querySelector("#player-wrap").getBoundingClientRect(); const pl=document.querySelector("#player").getBoundingClientRect(); return {wrapW:Math.round(w.width), stageVisW:Math.round(pl.width), gap:Math.round(w.width-pl.width)};});
await p.screenshot({ path: root+"/verification/studio/fixed.png" });
console.log("tree nodes (recursive):", nodes);
console.log("wrap width:", fit.wrapW, "stage visual width:", fit.stageVisW, "gap (black band):", fit.gap+"px");
await b.close();
