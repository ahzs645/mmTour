import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage();
await p.goto("http://127.0.0.1:5173/convert-play.html", { waitUntil:"load", timeout: 30000 });
const t0=Date.now();
await p.getByRole("button",{name:"segment5",exact:true}).click();
await p.waitForSelector(".card:not(.busy) .play", { timeout: 200000 });
const ms = await p.locator(".card .meta").first().innerText();
console.log("segment5 wall-clock to card:", ((Date.now()-t0)/1000).toFixed(1)+"s | card meta:", ms.replace(/\n/g," "));
await b.close();
