// Native-style cascading menus. Commands remain in the application's action layer.
export function mountMenubar({host,menus,enabled,invoke,rememberContext,shortcuts={}}){
 const nav=document.createElement('nav');nav.className='app-menubar';nav.setAttribute('role','menubar');nav.setAttribute('aria-label','Application Menu');host.append(nav);
 let active=-1,levels=[],returnFocus=null,lastFocus=null,hoverTimer,typeTimer,typeahead='';
 document.addEventListener('focusin',e=>{if(!nav.contains(e.target)&&!levels.some(l=>l.el.contains(e.target)))lastFocus=e.target;});
 const roots=menus.map(([name],i)=>{const b=document.createElement('button');b.type='button';b.textContent=name;b.setAttribute('role','menuitem');b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');b.tabIndex=i?-1:0;b.onclick=()=>active===i?close(true):open(i);b.onpointerenter=()=>{if(active>=0&&active!==i)open(i);};nav.append(b);return b;});
 const rows=level=>[...level.el.querySelectorAll('[role^="menuitem"]')].filter(b=>b.getAttribute('aria-disabled')!=='true');
 function trim(depth){clearTimeout(hoverTimer);while(levels.length>depth){const level=levels.pop();level.el.remove();level.trigger?.setAttribute('aria-expanded','false');}levels.forEach(l=>l.el.hidden=false);}
 function close(restore=false){const root=roots[active],hadFocus=levels.some(l=>l.el.contains(document.activeElement));trim(0);roots.forEach(b=>b.setAttribute('aria-expanded','false'));document.body.classList.remove('menu-open');active=-1;typeahead='';clearTimeout(typeTimer);if(restore)(returnFocus?.isConnected?returnFocus:root)?.focus({preventScroll:true});else if(hadFocus)root?.focus({preventScroll:true});}
 function open(i,fromEnd=false){if(active<0){returnFocus=lastFocus||document.activeElement;rememberContext(returnFocus);}trim(0);active=i;roots.forEach((b,j)=>{b.tabIndex=j===i?0:-1;b.setAttribute('aria-expanded',String(j===i));});document.body.classList.add('menu-open');create(menus[i][1],0,roots[i],menus[i][0],true,fromEnd);}
 function position(level,depth){const bounds=level.trigger.getBoundingClientRect(),el=level.el,w=el.getBoundingClientRect().width,h=el.getBoundingClientRect().height;
  let left=depth?bounds.right-1:bounds.left,top=depth?bounds.top-4:host.getBoundingClientRect().bottom+1;
  const compact=depth&&innerWidth<w*2+12;if(compact){left=levels[0].el.getBoundingClientRect().left;top=host.getBoundingClientRect().bottom+1;for(const parent of levels.slice(0,depth))parent.el.hidden=true;}
  else if(depth&&left+w>innerWidth-4)left=bounds.left-w+1;
  el.style.left=Math.max(4,Math.min(left,innerWidth-w-4))+'px';el.style.top=Math.max(4,Math.min(top,innerHeight-h-4))+'px';
 }
 function back(depth){const trigger=levels[depth].trigger;trim(depth);trigger.focus({preventScroll:true});}
 function create(entries,depth,trigger,label,focus=false,fromEnd=false){
  trim(depth);const el=document.createElement('div');el.className='app-menu-popup';el.id='opus-menu-'+depth;el.setAttribute('role','menu');el.setAttribute('aria-label',label);el.dataset.menuDepth=depth;const level={el,trigger};levels.push(level);document.body.append(el);trigger.setAttribute('aria-controls',el.id);trigger.setAttribute('aria-expanded','true');
  if(depth&&innerWidth<672){const b=document.createElement('button');b.type='button';b.className='menu-back';b.textContent='‹ '+label;b.setAttribute('role','menuitem');b.tabIndex=-1;b.onclick=()=>back(depth);el.append(b);}
  for(const entry of entries){if(!entry){const hr=document.createElement('hr');hr.setAttribute('role','separator');el.append(hr);continue;}
   const b=document.createElement('button');b.type='button';b.tabIndex=-1;b.setAttribute('role',entry.checked?(entry.checkedRole==='radio'?'menuitemradio':'menuitemcheckbox'):'menuitem');if(entry.checked)b.setAttribute('aria-checked',String(entry.checked()));b.setAttribute('aria-label',entry.label);b.setAttribute('aria-disabled',String(!enabled(entry)));b.title=entry.note||(!enabled(entry)?'Unavailable For The Current Selection Or During Playback.':'');
   const text=document.createElement('span');text.textContent=entry.label;const hint=document.createElement('small');hint.textContent=entry.children?'›':entry.checked?.()?'✓':shortcuts[entry.label]||'';b.append(text,hint);
   if(entry.children){b.setAttribute('aria-haspopup','menu');b.setAttribute('aria-expanded','false');}
   const submenu=focusChild=>{if(levels[depth+1]?.trigger===b){if(focusChild)rows(levels[depth+1])[0]?.focus();return;}create(entry.children,depth+1,b,entry.label,focusChild);};
   b.onpointerenter=e=>{if(e.pointerType==='touch')return;clearTimeout(hoverTimer);b.focus({preventScroll:true});hoverTimer=setTimeout(()=>{if(!b.isConnected)return;if(entry.children&&enabled(entry))submenu(false);else trim(depth+1);},120);};
   b.onclick=()=>{clearTimeout(hoverTimer);if(!enabled(entry))return;if(entry.children)submenu(true);else{close();invoke(entry);}};
   el.append(b);
  }
  el.onpointerenter=()=>clearTimeout(hoverTimer);position(level,depth);if(focus){const items=rows(level);items[fromEnd?items.length-1:0]?.focus({preventScroll:true});}
 }
 document.addEventListener('pointerdown',e=>{if(active>=0&&!nav.contains(e.target)&&!levels.some(l=>l.el.contains(e.target)))close();},true);
 document.addEventListener('keydown',e=>{
  if(document.querySelector('dialog[open]'))return;
  if(active<0){
   if(e.altKey&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey){const i=menus.findIndex(([name])=>name[0].toLowerCase()===e.key.toLowerCase());if(i>=0){e.preventDefault();e.stopImmediatePropagation();open(i);return;}}
   if(nav.contains(e.target)){const i=roots.indexOf(e.target);if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();roots[(i+(e.key==='ArrowRight'?1:roots.length-1))%roots.length].focus();}else if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();open(i,e.key==='ArrowUp');}}return;
  }
  e.stopImmediatePropagation();const depth=levels.findIndex(l=>l.el.contains(document.activeElement)),level=levels[Math.max(0,depth)];
  if(e.key==='Escape'){e.preventDefault();if(levels.length>1)back(levels.length-1);else close(true);return;}
  if(e.key==='Tab'){close(true);return;}
  if(e.key==='ArrowLeft'&&depth>0){e.preventDefault();back(depth);return;}
  if(e.key==='ArrowRight'&&document.activeElement.getAttribute('aria-haspopup')==='menu'&&depth>=0){e.preventDefault();document.activeElement.click();return;}
  if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();open((active+(e.key==='ArrowRight'?1:roots.length-1))%roots.length);return;}
  const items=rows(level),index=items.indexOf(document.activeElement);
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();trim(Math.max(0,depth)+1);items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus({preventScroll:true});return;}
  if(['Enter',' '].includes(e.key)){e.preventDefault();document.activeElement.click();return;}
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();clearTimeout(typeTimer);typeahead+=e.key.toLowerCase();typeTimer=setTimeout(()=>typeahead='',600);items.find(b=>(b.getAttribute('aria-label')||b.textContent).toLowerCase().startsWith(typeahead))?.focus({preventScroll:true});}
 },true);
 window.addEventListener('resize',()=>{if(active>=0)close();});window.addEventListener('blur',()=>{if(active>=0)close();});
}
