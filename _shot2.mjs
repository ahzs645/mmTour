import { spawn } from "node:child_process";
const HOST="127.0.0.1",PORT=5302,base=`http://${HOST}:${PORT}`;
async function wait(u,ms){const s=Date.now();while(Date.now()-s<ms){try{const r=await fetch(u);if(r.ok||r.status===404)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw 0;}
let srv,b;
try{
  srv=spawn("node_modules/.bin/vite",["--host",HOST,"--port",String(PORT),"--strictPort"],{stdio:"ignore"});
  await wait(`${base}/smoke.html`,60000);
  const {chromium}=await import("playwright");
  b=await chromium.launch({headless:true});
  for (const src of ["files","archive"]) {
    const page=await b.newPage({viewport:{width:660,height:500}});
    await page.goto(`${base}/smoke.html?source=${src}`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>window.__smoke&&window.__smoke.status!=="loading",null,{timeout:60000});
    await page.waitForTimeout(9000);
    await page.screenshot({path:`/tmp/cmp-${src}.png`});
    await page.close();
    console.log(src,"done");
  }
  await b.close();
}finally{ if(b)await b.close().catch(()=>{}); if(srv)srv.kill("SIGTERM"); }
