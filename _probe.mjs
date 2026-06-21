import { chromium } from "playwright";
const b=await chromium.launch({headless:true});
const page=await b.newPage({viewport:{width:1280,height:800}});
await page.goto("http://localhost:5176",{waitUntil:"domcontentloaded"});
await page.waitForTimeout(3500);
await page.screenshot({path:"/tmp/xport-desktop.png"});
const texts = await page.evaluate(()=>{
  const out=[];
  document.querySelectorAll("*").forEach(el=>{
    const t=(el.textContent||"").trim();
    if(/tour/i.test(t) && el.children.length===0) out.push({tag:el.tagName,cls:el.className,txt:t.slice(0,40)});
  });
  return out.slice(0,20);
});
console.log(JSON.stringify(texts,null,1));
await b.close();
