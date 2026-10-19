import {RECENT_INDEX,recentIndex,recentKey} from './recent-sets.js';
export function installRecentSetsDialog({read,exclusive,replaceSet,setStatus}){
 const dialog=document.createElement('dialog');dialog.id='recent-sets-dialog';dialog.className='studio-dialog';dialog.setAttribute('aria-labelledby','recent-sets-title');
 dialog.innerHTML=`<div class="dialog-heading"><h2 id="recent-sets-title">Open Recent Set</h2><button id="recent-close" aria-label="Close Recent Sets"><svg class="studio-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><use href="#opus-icon-close"/></svg></button></div>
 <p class="micro">Pick up where you left off. Switching sets saves the latest edits to the set you leave.</p>
 <label for="recent-list">Recent Sets In This Browser</label><select id="recent-list" size="5"></select>
 <p id="recent-summary" class="micro"></p><p class="micro">Keeps up to five sets within 64 MB. Larger sets remain in Previous Set only. Download projects for permanent backups. This list is specific to this browser and site address.</p>
 <div class="preset-actions"><button id="recent-open" class="primary">Open Selected Set</button><button id="recent-cancel">Cancel</button></div><p id="recent-status" role="status" aria-live="polite"></p>`;
 document.body.append(dialog);const $=id=>dialog.querySelector('#'+id);let items=[],working=false,lastFocus;
 function update(){const item=items.find(x=>x.id===$('recent-list').value);$('recent-open').disabled=working||!item;$('recent-summary').textContent=item?`${item.tracks} Tracks · ${item.clips} Clips · ${item.bpm} BPM · Left ${new Date(item.savedAt).toLocaleString()}`:'No recent sets yet. Sets appear here after you open or create another set.';}
 function close(){if(working)return;dialog.close();lastFocus?.focus();}
 for(const id of ['recent-close','recent-cancel'])$(id).onclick=close;
 dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('keydown',e=>e.stopPropagation());$('recent-list').onchange=update;
 $('recent-open').onclick=async()=>{
  if(working||!$('recent-list').value)return;working=true;dialog.querySelectorAll('button,select').forEach(el=>el.disabled=true);
  try{await exclusive(async()=>{const id=$('recent-list').value,index=recentIndex(await read(RECENT_INDEX)),entry=index.entries.find(x=>x.id===id);if(!entry)throw Error('That recent set is no longer available. Close and reopen this list.');const next=await read(recentKey(id));if(!next)throw Error('That recent set could not be loaded. Your current set is unchanged.');const result=await replaceSet(next,{recentId:id});dialog.close();lastFocus?.focus();setStatus(`Opened ${next.name}. Your replaced set is available in ${result.archived?'Open Recent Set and Previous Set':'Previous Set only (larger than 64 MB)'}.`);});}
  catch(error){$('recent-status').textContent=error.message;setStatus(error.message,true);}
  finally{working=false;dialog.querySelectorAll('button,select').forEach(el=>el.disabled=false);update();}
 };
 return async()=>{
  lastFocus=document.activeElement;items=[];$('recent-list').replaceChildren();$('recent-status').textContent='Loading…';working=true;update();dialog.showModal();
  try{items=recentIndex(await read(RECENT_INDEX)).entries;$('recent-list').replaceChildren(...items.map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.name;return option;}));if(items.length)$('recent-list').value=items[0].id;$('recent-status').textContent='';}
  catch(error){$('recent-status').textContent=error.message;}
  finally{working=false;update();$('recent-list').focus();}
 };
}
