import {historyState,assertHistoryState} from './history-control.js';
// Compare serializable values without stringifying or duplicating embedded media.
function equal(a,b){
 if(a===b)return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
}
export function historyEditLabel(before,after){
 const labels=[];
 if(before.name!==after.name)labels.push('Rename Set');
 if(before.bpm!==after.bpm)labels.push('Tempo');
 if(before.master!==after.master||!equal(before.crossfade,after.crossfade))labels.push('Master Mix');
 if(before.tracks.length!==after.tracks.length)labels.push(after.tracks.length>before.tracks.length?'Add Tracks':'Remove Tracks');
 else if(!equal(before.tracks.map(t=>t.id),after.tracks.map(t=>t.id)))labels.push('Reorder Tracks');
 if(!equal(before.returns,after.returns))labels.push('Return Channels');
 if(before.scenes!==after.scenes||!equal(before.sceneNames,after.sceneNames)||!equal(before.sceneFollows,after.sceneFollows))labels.push('Scenes');
 if(!equal(before.arrangement,after.arrangement))labels.push('Arrangement');
 const oldTracks=new Map(before.tracks.map(t=>[t.id,t]));
 for(const track of after.tracks){
  const old=oldTracks.get(track.id);if(!old)continue;
  if(old.name!==track.name)labels.push('Rename Tracks');
  if(['volume','pan','mute','solo','sends','output','crossfade'].some(key=>!equal(old[key],track[key])))labels.push('Track Mix');
  if(!equal(old.devices,track.devices)||!equal(old.instrument,track.instrument)||!equal(old.midiEffects,track.midiEffects))labels.push('Devices');
  if(!equal(old.automation,track.automation))labels.push('Automation');
  if(!equal(old.slots,track.slots)||!equal(old.noStopSlots,track.noStopSlots)||!equal(old.inactiveSlots,track.inactiveSlots))labels.push('Session Clips');
 }
 if(!equal(before.clips,after.clips))labels.push('Clip Content');
 if(!equal(before.transport,after.transport))labels.push('Transport Settings');
 if(!equal(before.locators,after.locators))labels.push('Locators');
 return [...new Set(labels)].slice(0,3).join(' · ')||'Project Edit';
}
export function historyTimeline(history){
 const binding=historyState(history),snapshots=[...history.past,history.current,...history.future.slice().reverse()],current=history.past.length;
 return {binding,current,entries:snapshots.map((project,index)=>({
  index,label:index?historyEditLabel(snapshots[index-1],project):'Oldest Available State',
  name:project.name,bpm:project.bpm,tracks:project.tracks.length,clips:Object.keys(project.clips).length,regions:project.arrangement.length,
  action:index<current?'undo':index>current?'redo':null,steps:Math.abs(index-current)
 }))};
}
export function historySelection(timeline,index,history){
 assertHistoryState(timeline.binding,historyState(history));
 const entry=timeline.entries.find(item=>item.index===index);
 if(!entry||!entry.action||!entry.steps)throw Error('Choose a different available history state.');
 return {action:entry.action,steps:entry.steps,binding:{...timeline.binding}};
}
export function installHistoryView({getHistory,isLocked,move,setStatus}){
 const dialog=document.createElement('dialog');dialog.id='history-dialog';dialog.className='studio-dialog';dialog.setAttribute('aria-labelledby','history-title');
 dialog.innerHTML=`<div class="dialog-heading"><h2 id="history-title">Undo History</h2><button id="history-close" aria-label="Close Undo History"><svg class="studio-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><use href="#opus-icon-close"/></svg></button></div>
 <p class="micro">Return to a project state, then redo forward if needed. Selecting a row does not change your set.</p>
 <label for="history-list">Project Edit History</label><select id="history-list" size="8"></select><p id="history-summary" class="micro"></p>
 <div class="preset-actions"><button id="history-restore" class="primary">Restore Selected State</button><button id="history-done">Done</button></div>
 <p class="micro">Up to 40 edits for this open set. New edits after Undo replace the redo branch. Opening another set or reloading starts a new history. Playback and downloads are not project edits.</p>
 <p id="history-status" role="status" aria-live="polite"></p>`;
 document.body.append(dialog);const $=id=>dialog.querySelector('#'+id);let timeline=null,lastFocus,restoring=false;
 function update(){
  const entry=timeline?.entries.find(item=>item.index===Number($('history-list').value));
  $('history-restore').disabled=restoring||isLocked()||!entry?.action;
  $('history-restore').textContent=entry?.action?`${entry.action==='undo'?'Undo':'Redo'} ${entry.steps} ${entry.steps===1?'Edit':'Edits'}`:'Current State';
  $('history-summary').textContent=entry?`${entry.name} · ${entry.bpm} BPM · ${entry.tracks} Tracks · ${entry.clips} Clips · ${entry.regions} Regions`:'';
 }
 function refresh(force=false){
  if(!dialog.open)return;const history=getHistory();if(!history)return;
  const state=historyState(history),changed=!timeline||JSON.stringify(state)!==JSON.stringify(timeline.binding);
  if(force||changed){
   timeline=historyTimeline(history);$('history-list').replaceChildren(...timeline.entries.map(entry=>{const option=document.createElement('option');option.value=String(entry.index);option.textContent=`${entry.index}. ${entry.label}${entry.index===timeline.current?' — Current':entry.action==='redo'?' — Redo Available':''}`;return option;}));$('history-list').value=String(timeline.current);
   if(changed&&!force&&!restoring)$('history-status').textContent='History Changed. Choose A State From The Updated List.';
  }
  update();
 }
 function close(){if(restoring)return;dialog.close();timeline=null;lastFocus?.focus();}
 for(const id of ['history-close','history-done'])$(id).onclick=close;
 dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('keydown',e=>e.stopPropagation());$('history-list').onchange=update;
 $('history-restore').onclick=()=>{
  if(restoring)return;
  try{
   if(isLocked())throw Error('Stop playback and finish the current operation before restoring history.');
   const intent=historySelection(timeline,Number($('history-list').value),getHistory());restoring=true;update();
   move(intent);$('history-status').textContent=`${intent.action==='undo'?'Undid':'Redid'} ${intent.steps} ${intent.steps===1?'Edit':'Edits'}.`;refresh(true);$('history-list').focus();
  }catch(error){$('history-status').textContent=error.message;setStatus(error.message,true);refresh(true);}
  finally{restoring=false;update();}
 };
 return {refresh,open(){lastFocus=document.activeElement;$('history-status').textContent='';dialog.showModal();refresh(true);$('history-list').focus();}};
}
