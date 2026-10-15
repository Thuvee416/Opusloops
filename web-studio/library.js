// Browse existing editor commands. Mutations stay in the app's undo-aware handlers.
export function installLibrary(host,openPanel){
 const $=id=>document.getElementById(id);
 const instruments=[['legacy','Original tone','Basic sine instrument'],['poly','Poly synth','Subtractive synthesizer'],['sampler','Sampler','Play an imported sample'],['drums','Drum rack','16 playable drum pads']];
 let presets=[];
 const midi=[['pitch','Pitch'],['velocity','Velocity'],['scale','Scale'],['chord','Chord'],['length','Note Length'],['arp','Arpeggiator']];
 host.innerHTML='<label class="library-search-label" for="library-search">Search library</label><div class="library-search-row"><input id="library-search" type="search" placeholder="Search sounds & devices" autocomplete="off"><button id="library-clear" aria-label="Clear library search">×</button></div><select id="library-category" aria-label="Library category"><option value="all">All items</option><option value="instrument">Instruments</option><option value="audio">Audio effects</option><option value="midi">MIDI effects</option><option value="clip">Session clips</option><option value="preset">Sound presets</option></select><p id="library-destination" class="micro"></p><div id="library-results" class="library-results" aria-label="Library results"></div><p id="library-count" class="micro" role="status" aria-live="polite"></p>';
 const search=$('library-search'),category=$('library-category'),results=$('library-results');
 const categoryList=document.createElement('nav');categoryList.className='library-categories';categoryList.setAttribute('aria-label','Browser categories');
 for(const option of category.options){const button=document.createElement('button');button.type='button';button.dataset.libraryCategory=option.value;button.textContent=option.textContent;button.onclick=()=>{category.value=option.value;category.dispatchEvent(new Event('change',{bubbles:true}));};categoryList.append(button);}
 const columns=document.createElement('div');columns.className='library-columns';category.before(columns);columns.append(categoryList,results);

 function catalog(){
  const instrument=$('instrument-type'),target=$('device-track')?.textContent||'selected track';
  const items=instruments.map(([value,name,description])=>({id:'instrument:'+value,type:'instrument',name,description,disabled:!instrument||instrument.disabled,action:()=>{const control=$('instrument-type');if(!control||control.disabled)return false;control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));return true;}}));
  for(const option of $('device-type').options)items.push({id:'audio:'+option.value,type:'audio',name:option.textContent,description:'Audio effect',disabled:$('add-device').disabled,action:()=>{if($('add-device').disabled)return false;$('device-type').value=option.value;$('add-device').click();return true;}});
  for(const [value,name]of midi){const control=$('add-midi-'+value);items.push({id:'midi:'+value,type:'midi',name,description:'MIDI effect',disabled:!control||control.disabled,action:()=>{const button=$('add-midi-'+value);if(!button||button.disabled)return false;button.click();return true;}});}
  for(const preset of presets)items.push({id:'preset:'+preset.id,type:'preset',name:preset.name,description:`Sound preset · ${preset.instrument} · ${preset.effects} audio / ${preset.midiEffects} MIDI effects`,disabled:!instrument||instrument.disabled,action:()=>{if(!$('instrument-type')||$('instrument-type').disabled)return false;document.dispatchEvent(new CustomEvent('opus-load-sound',{detail:preset.id}));return true;}});
  const names=new Map([...document.querySelectorAll('[data-track-name]')].map(el=>[el.dataset.trackName,el.value]));
  for(const button of document.querySelectorAll('#session-grid [data-select]')){const slot=button.closest('.slot'),track=slot.dataset.track,scene=slot.dataset.scene,clip=button.dataset.select,name=button.querySelector('span').textContent;
   items.push({id:JSON.stringify([track,scene,clip]),type:'clip',name,description:`${names.get(track)} · scene ${Number(scene)+1}`,disabled:false,action:()=>{const current=[...document.querySelectorAll('#session-grid [data-select]')].find(el=>el.dataset.select===clip&&el.closest('.slot').dataset.track===track&&el.closest('.slot').dataset.scene===scene);if(!current)return false;$('session-tab').click();current.click();return true;}});
  }
  return {items,target};
 }
 let signature='';
 function render(){
  for(const button of categoryList.children)button.setAttribute('aria-pressed',String(button.dataset.libraryCategory===category.value));
  const {items,target}=catalog(),query=search.value.trim().toLocaleLowerCase(),words=query.split(/\s+/).filter(Boolean),visible=items.filter(item=>(category.value==='all'||item.type===category.value)&&words.every(word=>`${item.name} ${item.description}`.toLocaleLowerCase().includes(word)));
  $('library-destination').textContent=category.value==='clip'?'Open a Session clip to edit it.':`Destination: ${target}. Loading an instrument replaces the current instrument; Undo restores it.`;
  const next=JSON.stringify([category.value,query,target,visible.map(({id,name,description,disabled})=>[id,name,description,disabled])]);if(next===signature)return;signature=next;
  const focused=document.activeElement?.dataset?.libraryItem;results.replaceChildren();
  for(const item of visible){const button=document.createElement('button');button.type='button';button.dataset.libraryItem=item.id;button.disabled=item.disabled;const action=item.type==='clip'?'Open':['instrument','preset'].includes(item.type)?'Load':'Add';button.setAttribute('aria-label',`${action} ${item.name}${item.type==='clip'?' — '+item.description:''}`);button.title=item.disabled?'Unavailable for this target or while editing is locked':`${action} ${item.name}${item.type==='clip'?'':' on '+target}`;
   const name=document.createElement('span');name.textContent=item.name;const description=document.createElement('small');description.textContent=item.description;button.append(name,description);
   button.onclick=()=>{if(item.action()){openPanel(item.type==='clip'?'clip':'devices');document.body.classList.remove('browser-mobile-open');render();}};results.append(button);
  }
  if(!visible.length){const empty=document.createElement('p');empty.className='library-empty';empty.textContent='No matching items. Try another search or category.';results.append(empty);}
  $('library-count').textContent=`${visible.length} ${visible.length===1?'item':'items'}`;
  if(focused)[...results.querySelectorAll('button')].find(el=>el.dataset.libraryItem===focused&&!el.disabled)?.focus({preventScroll:true});
 }
 search.addEventListener('input',render);category.addEventListener('change',render);$('library-clear').onclick=()=>{search.value='';render();search.focus();};
 search.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();search.value='';render();}if(e.key==='ArrowDown'){e.preventDefault();results.querySelector('button:not(:disabled)')?.focus();}});
 let queued=false;const observer=new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;render();});});
 for(const id of ['session-grid','device-track','instrument','midi-effects','add-device'])observer.observe($(id),{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
 // Track names can change through inputs before a grid rebuild.
 $('session-grid').addEventListener('change',render);document.addEventListener('opus-sound-presets',e=>{presets=e.detail;render();});render();
}
