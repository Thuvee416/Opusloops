import {installMenus} from './menus.js';
import {installLibrary} from './library.js';
// Workspace chrome owns navigation; the audio/editor modules retain their controls.
const $ = s => document.querySelector(s);
const main = $('main');
document.body.classList.add('studio-shell');
$('.beta').textContent = 'WEB STUDIO';
const browser = $('.browser');
const imports = [$('#import'), $('#import-midi')];
browser.replaceChildren();
browser.innerHTML = `<div class="browser-title">LIBRARY <button id="close-browser" aria-label="Close library">×</button></div><p class="browser-caption">Find your next idea.</p><section id="studio-library" aria-label="Sound and device browser"></section><div class="library-group import-group"><span class="section-label">YOUR FILES</span></div><p class="micro">Drop an audio file onto a clip slot to start a loop.</p><div class="library-group"><span class="section-label">CAPTURE</span><button data-panel-link="recording">● <span>Audio & MIDI input</span></button></div><div class="browser-bottom"><i class="local-dot"></i> Saved in this browser<p>Save a project file to keep a copy.</p></div>`;
imports.forEach(el => $('.import-group').append(el));
const viewbar = $('.viewbar');
viewbar.insertAdjacentHTML('afterbegin','<button id="toggle-browser" aria-label="Toggle browser" aria-expanded="true" title="Show or hide library">◧</button>');
$('.view-actions').insertAdjacentHTML('beforeend','<button id="manage-set">Manage set</button><button id="toggle-mixer" aria-pressed="true">Mixer</button>');
const stage = document.createElement('div'); stage.className = 'studio-stage';
main.insertBefore(stage, $('#session-view'));
const mixer = document.createElement('section'); mixer.className='studio-mixer';
mixer.append($('.mixer-heading'), $('#mixer'));
stage.append($('#session-view'), $('#arrangement-view'), mixer);
const detail = document.createElement('section');detail.className='detail-panel';detail.setAttribute('aria-label','Detail view');
detail.innerHTML=`<div class="detail-tabs" role="tablist" aria-label="Detail editor"><button role="tab" id="detail-clip" data-panel="clip" aria-controls="panel-clip">Clip</button><button role="tab" id="detail-devices" data-panel="devices" aria-controls="panel-devices">Devices</button><button role="tab" id="detail-recording" data-panel="recording" aria-controls="panel-recording">Recording</button><button role="tab" id="detail-returns" data-panel="returns" aria-controls="panel-returns">Returns</button><span class="detail-context">Select a clip to edit · select a track for devices</span><button id="toggle-detail" aria-label="Collapse detail view" aria-expanded="true">⌄</button></div><div class="detail-content"></div>`;
main.append(detail);
for(const [name,selector] of [['clip','.editor'],['devices','.device-rack'],['recording','.input-rack'],['returns','.return-rack']]){const panel=$(selector);panel.id=`panel-${name}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',`detail-${name}`);$('.detail-content').append(panel);}
function openPanel(name){for(const button of document.querySelectorAll('[data-panel]')){const active=button.dataset.panel===name;button.setAttribute('aria-selected',active);button.tabIndex=active?0:-1;$('#panel-'+button.dataset.panel).hidden=!active;}detail.classList.remove('collapsed');$('#toggle-detail').setAttribute('aria-expanded','true');$('#toggle-detail').setAttribute('aria-label','Collapse detail view');}
document.addEventListener('click',e=>{const panel=e.target.closest('[data-panel],[data-panel-link]');if(panel){openPanel(panel.dataset.panel||panel.dataset.panelLink);document.body.classList.remove('browser-mobile-open');}if(e.target.closest('[data-select],[data-region]'))openPanel('clip');if(e.target.closest('[data-return-effects]'))openPanel('devices');});
$('.detail-tabs').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||!e.target.matches('[data-panel]'))return;e.preventDefault();const tabs=[...document.querySelectorAll('[data-panel]')];let i=tabs.indexOf(e.target);i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;openPanel(tabs[i].dataset.panel);tabs[i].focus();});
$('#toggle-detail').onclick=()=>{const collapsed=detail.classList.toggle('collapsed');$('#toggle-detail').setAttribute('aria-expanded',!collapsed);$('#toggle-detail').setAttribute('aria-label',collapsed?'Expand detail view':'Collapse detail view');};
$('#toggle-browser').onclick=()=>{if(matchMedia('(max-width:720px)').matches){const shown=document.body.classList.toggle('browser-mobile-open');$('#toggle-browser').setAttribute('aria-expanded',shown);}else{const hidden=document.body.classList.toggle('browser-collapsed');$('#toggle-browser').setAttribute('aria-expanded',!hidden);}};
$('#toggle-mixer').onclick=()=>{mixer.hidden=!mixer.hidden;$('#toggle-mixer').setAttribute('aria-pressed',!mixer.hidden);};
// Keep infrequent project operations in dismissible dialogs.
function settingsDialog(selector,id,title,trigger){const content=$(selector),dialog=document.createElement('dialog');dialog.id=id;dialog.className='studio-dialog';dialog.innerHTML=`<div class="dialog-heading"><h2>${title}</h2><button aria-label="Close ${title.toLowerCase()}">×</button></div>`;dialog.append(content);document.body.append(dialog);content.open=true;dialog.querySelector('button').onclick=()=>dialog.close();trigger.onclick=()=>dialog.showModal();dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});}
$('.file-actions').insertAdjacentHTML('beforeend','<button id="export-options" aria-label="Export settings" title="Export settings">⚙</button>');
settingsDialog('.export-settings','export-dialog','Export settings',$('#export-options'));
settingsDialog('.set-manager','manage-dialog','Manage set',$('#manage-set'));
// Arrangement tools are grouped by the operation, above the timeline.
const tools=document.createElement('div');tools.className='arrangement-tools';
$('#arrangement-view').insertBefore(tools,$('#timeline'));
for(const [title,selector] of [['View','#viewport-controls'],['Time edits','#time-edit-controls'],['Locators','#locator-controls'],['MIDI range','#midi-range-controls'],['Automation','.automation-editor']]){const group=document.createElement('details');group.className='arrangement-tool';const summary=document.createElement('summary');summary.textContent=title;group.append(summary,$(selector));tools.append(group);group.addEventListener('toggle',()=>{if(group.open)for(const other of tools.children)if(other!==group)other.open=false;});}
openPanel('clip');
// Track labels double as a direct route to the selected device chain.
$('#mixer').addEventListener('click',e=>{const button=e.target.closest('[data-open-devices]');if(!button)return;const select=$('#device-target');select.value=button.dataset.openDevices;select.dispatchEvent(new Event('change',{bubbles:true}));openPanel('devices');});

$('#close-browser').onclick=()=>{document.body.classList.remove('browser-mobile-open');document.body.classList.add('browser-collapsed');$('#toggle-browser').setAttribute('aria-expanded','false');$('#toggle-browser').focus();};

// A persistent split gives note editing and device programming room without leaving the set.
const divider=document.createElement('div');
divider.className='detail-divider';divider.tabIndex=0;divider.setAttribute('role','separator');
divider.setAttribute('aria-label','Resize detail view');divider.setAttribute('aria-orientation','horizontal');
divider.setAttribute('aria-controls','studio-detail');divider.setAttribute('aria-valuemin','20');divider.setAttribute('aria-valuemax','65');
divider.title='Drag to resize · Arrow keys to adjust · Home/End for limits';detail.id='studio-detail';main.insertBefore(divider,detail);
let detailSize=34;
try{const saved=Number(localStorage.getItem('opus-detail-size'));if(Number.isFinite(saved)&&saved>=20&&saved<=65)detailSize=saved;}catch{}
function resizeDetail(value,save=true){detailSize=Math.max(20,Math.min(65,Math.round(value)));detail.style.setProperty('--detail-size',detailSize+'%');divider.setAttribute('aria-valuenow',String(detailSize));divider.setAttribute('aria-valuetext',detailSize+' percent of workspace');if(save)try{localStorage.setItem('opus-detail-size',String(detailSize));}catch{}}
function expandDetail(){detail.classList.remove('collapsed');$('#toggle-detail').setAttribute('aria-expanded','true');$('#toggle-detail').setAttribute('aria-label','Collapse detail view');}
resizeDetail(detailSize,false);
let resizePointer=null;
divider.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();expandDetail();resizePointer=e.pointerId;divider.setPointerCapture(e.pointerId);divider.focus();});
divider.addEventListener('pointermove',e=>{if(resizePointer!==e.pointerId)return;const bounds=main.getBoundingClientRect();resizeDetail((bounds.bottom-e.clientY)/bounds.height*100,false);});
function finishResize(e){if(resizePointer!==e.pointerId)return;resizePointer=null;resizeDetail(detailSize);if(divider.hasPointerCapture(e.pointerId))divider.releasePointerCapture(e.pointerId);}
divider.addEventListener('pointerup',finishResize);divider.addEventListener('pointercancel',finishResize);
divider.addEventListener('lostpointercapture',()=>{resizePointer=null;});
divider.addEventListener('keydown',e=>{const step=e.shiftKey?10:2;const value={ArrowUp:detailSize+step,ArrowDown:detailSize-step,Home:20,End:65}[e.key];if(value===undefined)return;e.preventDefault();expandDetail();resizeDetail(value);});
divider.addEventListener('dblclick',()=>{expandDetail();resizeDetail(34);});

const exportAction=document.createElement('button');exportAction.id='export-confirm';exportAction.className='primary';exportAction.textContent='Export WAV';$('#export-dialog').append(exportAction);exportAction.onclick=()=>{$('#export-dialog').close();$('#export').click();};

installLibrary($('#studio-library'),openPanel);

const presetManager=document.createElement('button');presetManager.id='sound-presets';presetManager.textContent='Sound presets…';$('#studio-library').append(presetManager);

// Keep the control bar and view selector in the same positions in both workspaces.
const transport=$('.transport');
transport.prepend($('#toggle-browser'),$('.tempo'),$('.transport-note'),$('#metronome'),$('.launch-quantization'));
transport.append($('.tabs'));
let workspaceView='session';const mixerVisibility={session:true,arrangement:false};
function setWorkspaceView(){const next=$('#arrangement-tab').classList.contains('active')?'arrangement':'session';if(next!==workspaceView){mixerVisibility[workspaceView]=!mixer.hidden;workspaceView=next;mixer.hidden=!mixerVisibility[next];$('#toggle-mixer').setAttribute('aria-pressed',String(!mixer.hidden));}document.body.classList.toggle('arrangement-active',next==='arrangement');}
new MutationObserver(setWorkspaceView).observe($('#arrangement-tab'),{attributes:true,attributeFilter:['class']});setWorkspaceView();
// Arrangement track headers open the same device target as Session headers.
$('#timeline').addEventListener('click',e=>{const button=e.target.closest('[data-timeline-devices]');if(!button)return;const select=$('#device-target');select.value=button.dataset.timelineDevices;select.dispatchEvent(new Event('change',{bubbles:true}));openPanel('devices');});

const deviceWorkspace=document.createElement('div');deviceWorkspace.className='device-workspace';$('#panel-devices').append(deviceWorkspace);deviceWorkspace.append($('#midi-effects'),$('#instrument'),$('#device-chain'));

installMenus();

// File commands are presented only in the application menu. Keep their existing
// command endpoints for the shared app handlers and export dialog.
const fileCommands=document.createElement('div');fileCommands.hidden=true;fileCommands.id='file-command-actions';
document.body.append(fileCommands);for(const id of ['open','save','export','export-options'])fileCommands.append($('#'+id));

// History commands are exposed through Edit; retain shared shortcut handlers.
const historyCommands=document.createElement('div');historyCommands.hidden=true;historyCommands.id='history-command-actions';
document.body.append(historyCommands);for(const id of ['undo','redo'])historyCommands.append($('#'+id));
