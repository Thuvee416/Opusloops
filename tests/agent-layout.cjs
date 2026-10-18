const {chromium}=require('@playwright/test');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch();
 const base=process.env.OPUS_TEST_URL||'http://127.0.0.1:4178';
 for(const [width,height] of [[1440,960],[1024,768],[390,844],[375,667]]){
  const page=await browser.newPage({viewport:{width,height}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('html:not([data-startup])').waitFor();
  const theme=await page.evaluate(()=>{
   const modal=getComputedStyle(document.getElementById('opus-welcome'));
   const agent=getComputedStyle(document.getElementById('studio-agent'));
   return {modal:modal.backgroundColor,agent:agent.backgroundColor,panel:getComputedStyle(document.body).getPropertyValue('--panel').trim(),fonts:[modal.fontFamily,agent.fontFamily],radius:modal.borderRadius};
  });
  assert.equal(theme.modal,theme.agent);assert.equal(theme.fonts[0],theme.fonts[1]);assert.equal(theme.radius,'3px');
  await page.screenshot({path:`/tmp/opus-welcome-${width}.png`});
  await page.getByRole('button',{name:'Enter Studio',exact:true}).click();
  assert.equal(await page.locator('dialog.studio-agent').count(),0);
  assert.equal(await page.getByRole('complementary',{name:'Studio agent',exact:true}).isVisible(),true);
  const bounds=await page.evaluate(()=>{
   const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
   return {agent:rect('#studio-agent'),main:rect('.studio-center>main'),page:document.documentElement.scrollWidth,view:innerWidth};
  });
  assert.ok(bounds.agent.x>=0&&bounds.agent.right<=width+1&&bounds.agent.bottom<=height+1,JSON.stringify(bounds));
  assert.ok(bounds.agent.width>200&&bounds.agent.height>=200);assert.ok(bounds.page<=bounds.view,JSON.stringify(bounds));
  if(width>1150)assert.ok(bounds.agent.x>=bounds.main.right);else assert.ok(bounds.agent.y>=bounds.main.bottom);
  await page.locator('.agent-log').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#play').evaluate(e=>e.classList.contains('playing')),false);
  await page.locator('#agent-prompt').fill('A warm bass with more space');await page.keyboard.press('Space');
  assert.equal(await page.locator('#play').evaluate(e=>e.classList.contains('playing')),false);
  await page.locator('#agent-prompt').press('Tab');await page.getByRole('button',{name:'Run agent',exact:true}).click();
  assert.equal(await page.locator('.agent-account').evaluate(e=>e.open),true);
  await page.getByLabel('Account email',{exact:true}).fill('preview@example.com');
  await page.locator('.agent-account summary').click();
  await page.getByRole('button',{name:'Collapse studio agent'}).click();
  assert.equal(await page.locator('#studio-agent').isVisible(),false);assert.equal(await page.locator('#agent-open').getAttribute('aria-expanded'),'false');
  await page.locator('#agent-open').click();assert.ok((await page.locator('#agent-prompt').inputValue()).includes('warm bass'));
  await page.locator('#arrangement-tab').click();assert.equal(await page.locator('#arrangement-tab').getAttribute('aria-selected'),'true');
  await page.locator('#session-tab').click();await page.screenshot({path:`/tmp/opus-inline-agent-${width}.png`});
  await page.evaluate(()=>sessionStorage.setItem('opus.agent.session',JSON.stringify({access_token:'TEST_ONLY'})));
  let release,arrived;const pending=new Promise(r=>arrived=r);
  await page.route('**/functions/v1/studio-agent',async route=>{await new Promise(r=>{release=r;arrived();});await route.fulfill({json:{summary:'Inline task completed.',actions:[]}}).catch(()=>{});});
  await page.getByRole('button',{name:'Run agent',exact:true}).click();await pending;
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Working status must not widen the mobile toolbar');
  await page.getByRole('button',{name:'Collapse studio agent'}).click();release();
  await page.waitForFunction(()=>document.querySelector('.agent-state').textContent==='Ready');
  await page.locator('#agent-open').click();await page.getByText('Inline task completed.',{exact:true}).waitFor();
  assert.equal(await page.locator('.agent-cancel').isDisabled(),true);assert.deepEqual(errors,[]);
  await page.close();
 }
 await browser.close();console.log('PASS: themed welcome, inline desktop/mobile dock, keyboard safety, account access, persistent collapse, and background session controls');
})().catch(e=>{console.error(e);process.exit(1)});
