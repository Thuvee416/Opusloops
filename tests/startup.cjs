const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch();
 const page=await browser.newPage();
 const url=process.env.OPUS_TEST_URL||'http://127.0.0.1:4178';
 await page.addInitScript(()=>{
  window.startupLeaks=[];
  function sample(){
   if(document.documentElement.hasAttribute('data-startup')){
    for(const e of document.body?.children||[]){
     if(e.id==='studio-startup'||['SCRIPT','STYLE'].includes(e.tagName))continue;
     const s=getComputedStyle(e);
     if(s.visibility==='visible'&&s.display!=='none'&&e.getBoundingClientRect().height>0)window.startupLeaks.push(e.tagName+'#'+e.id);
    }
   }
   requestAnimationFrame(sample);
  }requestAnimationFrame(sample);
 });
 await page.route('**/*.js',async route=>{await new Promise(r=>setTimeout(r,180));await route.continue()});
 await page.goto(url,{waitUntil:'commit'});
 await page.locator('#studio-startup').waitFor({state:'visible'});
 await page.locator('html:not([data-startup])').waitFor();
 assert.deepEqual(await page.evaluate(()=>window.startupLeaks),[]);
 assert.equal(await page.locator('#opus-welcome').isVisible(),true);
 assert.equal(await page.locator('.studio-stage').count(),1);
 assert.ok(await page.locator('#session .slot').count().catch(()=>0)||await page.locator('.slot').count());
 await page.getByRole('button',{name:'Enter Studio'}).click();
 assert.equal(await page.locator('.topbar').isVisible(),true);
 await page.unrouteAll();
 await page.route('**/app.js',route=>route.abort());
 await page.goto(url);
 await page.locator('html[data-startup="error"]').waitFor();
 assert.equal(await page.locator('#startup-retry').isVisible(),true);
 assert.equal(await page.locator('.topbar').isVisible(),false);
 console.log('PASS: slow cold startup never exposes legacy UI; ready studio and welcome; failure offers retry without leaking partial UI');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
