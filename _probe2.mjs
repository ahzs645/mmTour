import { chromium } from "playwright";
const b=await chromium.launch({headless:true});
const page=await b.newPage({viewport:{width:1280,height:800}});
await page.goto("http://localhost:5176",{waitUntil:"domcontentloaded"});
await page.waitForTimeout(6000);
await page.mouse.click(765,370);
await page.waitForTimeout(3000);
// dump desktop icon labels
const labels = await page.evaluate(()=>{
  const out=new Set();
  document.querySelectorAll("*").forEach(el=>{
    if(el.children.length===0){
      const t=(el.textContent||"").trim();
      if(t && t.length<30) out.add(el.tagName+":"+t);
    }
  });
  return [...out];
});
console.log("LABELS:", JSON.stringify(labels));
await b.close();
