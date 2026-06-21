import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage({ viewport:{width:1100,height:900} });
const errs=[]; p.on("pageerror",e=>errs.push(e.message.slice(0,100)));
await p.goto("http://127.0.0.1:5173/convert-play.html", { waitUntil:"load", timeout: 30000 });
// batch: click all samples quickly (simulates dropping all at once)
for (const s of ["A-tour","intro","nav","segment1","segment4","segment5"]) await p.getByRole("button",{name:s,exact:true}).click();
// wait until no card is busy and no dep line is still "linking"
const t0=Date.now();
await p.waitForFunction(()=>{const cards=[...document.querySelectorAll(".card")]; return cards.length>=6 && cards.every(c=>!c.classList.contains("busy") && !/linking/.test(c.querySelector(".dep")?.textContent||""));}, {timeout:300000});
const elapsed=((Date.now()-t0)/1000).toFixed(0);
// count cards per scene name (detect duplicates)
const names = await p.$$eval(".card h3", hs=>hs.map(h=>h.textContent.split(" ")[0]));
const counts={}; for(const n of names) counts[n]=(counts[n]||0)+1;
const dupes = Object.entries(counts).filter(([,c])=>c>1);
const times = await p.$$eval(".card", cs=>cs.map(c=>({name:c.querySelector("h3").textContent.split(" ")[0], ms:(c.querySelector(".meta")?.textContent.match(/in (\d+) ms/)||[])[1]})));
console.log("settled in", elapsed+"s | cards:", names.length, "| duplicates:", dupes.length?JSON.stringify(dupes):"NONE");
console.log("compile times:", times.filter(t=>t.ms).map(t=>t.name+"="+(t.ms/1000).toFixed(1)+"s").join(" "));
console.log("errors:", errs.slice(0,2).join(" | ")||"none");
await b.close();
