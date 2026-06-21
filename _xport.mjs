import { chromium } from "playwright";
const base="http://localhost:5176";
const b=await chromium.launch({headless:true});
const page=await b.newPage({viewport:{width:1280,height:800}});
const errors=[], packs=[];
page.on("pageerror",e=>errors.push("PAGEERR "+e.message.slice(0,160)));
page.on("requestfailed",r=>{ const u=r.url(); if(/xp-tour|\.pack/.test(u)) errors.push("REQFAIL "+u.split("/").pop()); });
page.on("response",r=>{ if(/\.pack/.test(r.url())) packs.push(r.status()+" "+(r.headers()["content-range"]||"full")); });
const log=[];
try{
  await page.goto(base,{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(6500);
  // login: click the user tile (contains "Computer Administrator")
  const tile = page.getByText("Computer Administrator").first();
  await tile.click({timeout:8000}).catch(()=>{});
  await page.waitForTimeout(4000);
  log.push("after-login");
  await page.screenshot({path:"/tmp/xp2-desktop.png"});
  // open Start menu
  const start = page.getByText(/^start$/i).first();
  await start.click({timeout:8000}).catch(async()=>{ await page.mouse.click(30,788); });
  await page.waitForTimeout(1500);
  await page.screenshot({path:"/tmp/xp2-start.png"});
  // click Tour entry
  const tour = page.getByText("Tour Windows XP").first();
  const n = await tour.count();
  log.push("tour entries:"+n);
  if(n){ await tour.click(); }
  await page.waitForTimeout(2000);
  await page.screenshot({path:"/tmp/xp2-chooser.png"});
  // Next
  const next = page.getByRole("button",{name:/Next/}).first();
  if(await next.count()){ await next.click(); }
  await page.waitForTimeout(500);
  for (const [i,ms] of [[0,1500],[1,2500],[2,2500],[3,3500],[4,3500]]){
    await page.waitForTimeout(ms);
    await page.screenshot({path:`/tmp/xp2-tour-${i}.png`});
  }
  log.push("done");
}catch(e){ log.push("ERR "+e.message.slice(0,160)); }
finally{
  console.log(JSON.stringify({log,packs:packs.slice(0,10),errors:errors.slice(0,10)}));
  await b.close();
}
