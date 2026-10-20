const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.OPUS_CHROMIUM});
 const results=[],errors=[];
 try{
  for(const viewport of [{width:1280,height:600},{width:390,height:600},{width:667,height:375}]){
   const page=await browser.newPage({viewport,hasTouch:true});page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   await page.goto('http://127.0.0.1:4196/');await page.waitForFunction(()=>!document.documentElement.dataset.startup);await page.evaluate(()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close()));
   const fixture=await page.evaluate(async()=>{const {emptyProject}=await import('/model.js'),p=emptyProject();p.name='Menu Navigation Verification';p.returns=[];p.sceneNames=['Intro','Lift','Breakdown','Return'];p.clips.phrase={id:'phrase',name:'Phrase',kind:'midi',beats:4,sourceBpm:120,notes:[{pitch:60,start:0,duration:1,velocity:.7}]};p.tracks[0].slots[0]='phrase';return p;});
   await page.locator('#project-file').setInputFiles({name:'Menu.opusloop',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForFunction(()=>document.getElementById('project-name').value==='Menu Navigation Verification');
   await page.evaluate(()=>{document.getElementById('session-tab').click();document.querySelector('[data-select="phrase"]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));});
   const origin=await page.evaluate(()=>({x:scrollX,y:scrollY}));
   const root=name=>page.getByRole('menubar').getByRole('menuitem',{name,exact:true});
   const visibleFocus=async()=>{
    const state=await page.evaluate(()=>{
     const e=document.activeElement,menu=e.closest('[role="menu"]');if(!menu)return {error:'No Focused Menu Command',tag:e.tagName};
     const r=e.getBoundingClientRect(),m=menu.getBoundingClientRect(),top=m.top+menu.clientTop,bottom=top+menu.clientHeight;
     return {label:e.getAttribute('aria-label')||e.textContent,visible:r.top>=top-1&&r.bottom<=bottom+1&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,disabled:e.getAttribute('aria-disabled'),x:scrollX,y:scrollY};
    });
    assert.equal(state.visible,true,JSON.stringify({viewport,state}));assert.notEqual(state.disabled,'true');assert.equal(state.x,origin.x);assert.equal(state.y,origin.y);return state.label;
   };
   const menus=[];
   for(const name of ['File','Edit','Create','Playback','View','Navigate','Options','Help']){
    await root(name).click();const first=await visibleFocus();await page.keyboard.press('End');const last=await visibleFocus();
    await page.keyboard.press('ArrowDown');assert.equal(await visibleFocus(),first);await page.keyboard.press('ArrowUp');assert.equal(await visibleFocus(),last);
    await page.keyboard.press('Home');assert.equal(await visibleFocus(),first);await page.keyboard.press('Escape');assert.equal(await page.locator('[role="menu"]').count(),0);menus.push({name,first,last});
   }
   // Typeahead must reveal a distant command and keep its return path visible.
   await root('Edit').click();await page.keyboard.type('record');assert.equal(await visibleFocus(),'Record Quantization');await page.keyboard.press('ArrowRight');await visibleFocus();
   await page.keyboard.press('End');assert.equal(await visibleFocus(),'Thirty-Second Note Quantization');await page.keyboard.press('ArrowLeft');assert.equal(await visibleFocus(),'Record Quantization');await page.keyboard.press('Escape');
   // Opening a long menu backwards also reveals its last available command.
   await root('Edit').focus();await page.keyboard.press('ArrowUp');assert.equal(await visibleFocus(),'Record Quantization');await page.keyboard.press('Escape');
   // Native touch navigation into and back out of a compact submenu.
   await root('Edit').tap();await page.getByRole('menuitem',{name:'Record Quantization',exact:true}).tap();
   if(viewport.width<672){assert.equal(await page.locator('#opus-menu-0').isHidden(),true);await page.locator('.menu-back').tap();assert.equal(await page.locator('#opus-menu-0').isVisible(),true);assert.equal(await visibleFocus(),'Record Quantization');}
   await page.keyboard.press('Escape');if(await page.locator('[role="menu"]').count())await page.keyboard.press('Escape');
   // Session contextual commands use the same scrolling behavior, including palettes.
   await page.locator('.slot').first().focus();await page.keyboard.press('Shift+F10');const contextFirst=await visibleFocus();
   // Keep the physical pointer over the menu while keyboard scrolling moves rows beneath it.
   const firstBox=await page.getByRole('menuitem',{name:contextFirst,exact:true}).boundingBox();await page.mouse.move(firstBox.x+firstBox.width/2,firstBox.y+firstBox.height/2);
   await page.keyboard.press('End');await page.waitForTimeout(200);assert.equal(await visibleFocus(),'Export MIDI Clip...');await page.keyboard.press('ArrowDown');await page.waitForTimeout(200);assert.equal(await visibleFocus(),contextFirst);
   await page.getByRole('menuitem',{name:'Duplicate',exact:true}).hover();assert.equal(await visibleFocus(),'Duplicate');
   await page.keyboard.type('export');assert.equal(await visibleFocus(),'Export MIDI Clip...');await page.keyboard.press('Escape');assert.equal(await page.locator('[role="menu"]').count(),0);
   // Keyboard Save still invokes the existing command and preserves the project.
   await root('File').click();await page.keyboard.type('save');assert.equal(await visibleFocus(),'Save Live Set');const pending=page.waitForEvent('download');await page.keyboard.press('Enter');const file=await pending;const saved=JSON.parse(fs.readFileSync(await file.path(),'utf8'));assert.deepEqual(saved,fixture);assert.equal(await page.locator('[role="menu"]').count(),0);assert.equal(await page.locator('#undo').isDisabled(),true);
   results.push({viewport,menus,typeaheadVisible:true,submenuReturnVisible:true,openFromEndVisible:true,touchSubmenuUsable:true,sessionContextVisible:true,stationaryPointerKeepsKeyboardFocus:true,realPointerHoverWorks:true,pageStationary:true,savedProjectExact:true,noUndo:true});await page.close();
  }
  assert.deepEqual(errors,[]);const proof={status:'passed',results,errors,scope:'Isolated local Chromium at desktop, narrow and short landscape viewports, including emulated touch. Native keyboard and touch menu navigation plus downloaded project equality. No physical-phone, screen-reader, personal-project or model-provider claim.'};fs.writeFileSync('tests/fixtures/menu-navigation-browser-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
