import { spawn } from "node:child_process";
import { chromium } from "playwright";
const HOST="127.0.0.1", PORT=5311, base=`http://${HOST}:${PORT}`;
async function wait(u,ms){const s=Date.now();while(Date.now()-s<ms){try{const r=await fetch(u);if(r.ok||r.status===404)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error("server timeout");}
let srv,b;
try{
  srv=spawn("node_modules/.bin/vite",["--host",HOST,"--port",String(PORT),"--strictPort"],{stdio:"ignore"});
  await wait(`${base}/smoke.html`,60000);
  b=await chromium.launch({headless:true});
  for (const src of ["files","archive"]) {
    const page=await b.newPage({viewport:{width:640,height:480}});
    const errors=[];
    page.on("console",m=>{ if(m.type()==="error") errors.push(m.text()); });
    page.on("pageerror",e=>errors.push("PAGEERR "+e.message));
    await page.goto(`${base}/smoke.html?source=${src}`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>window.__smoke&&window.__smoke.status!=="loading",null,{timeout:60000});
    const st=await page.evaluate(()=>window.__smoke);
    for (const [i,ms] of [[0,2500],[1,2500],[2,3000]]){
      await page.waitForTimeout(ms);
      await page.screenshot({path:`/tmp/tour-${src}-${i}.png`});
    }
    console.log(JSON.stringify({src,status:st,errors:errors.slice(0,8)}));
    await page.close();
  }
}finally{ if(b)await b.close().catch(()=>{}); if(srv)srv.kill("SIGTERM"); }
