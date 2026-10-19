// Project/audio gains remain linear. These helpers only translate mixer UI values.
const finite=(value,min,max)=>{if(!Number.isFinite(value)||value<min||value>max)throw Error('Invalid mixer value.');return value;};
export function mixerValueText(kind,value){
 if(kind==='volume'){finite(value,0,1);return value===0?'−∞':`${Number((20*Math.log10(value)).toFixed(2))} dB`;}
 finite(value,-1,1);return value===0?'C':`${Number((Math.abs(value)*100).toFixed(2))}${value<0?'L':'R'}`;
}
export function parseMixerValue(kind,text){
 const value=String(text).trim().toLowerCase().replaceAll('−','-');
 if(kind==='volume'){
  if(['-inf','-infinity','-∞','silence','-inf db','-infinity db','-∞ db'].includes(value))return 0;
  if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:\s*db)?$/.test(value))throw Error('Enter A Level In dB, Or -inf For Silence.');
  const db=Number(value.replace(/\s*db$/,''));if(!Number.isFinite(db)||db>0||db<-6000)throw Error('Level Must Be Between -6000 And 0 dB, Or -inf.');return 10**(db/20);
 }
 if(['c','center','centre'].includes(value))return 0;
 const match=value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([lr])?$/);if(!match)throw Error('Enter C, 0, A Signed Pan Percentage, Or A Value Like 25L.');
 const n=Number(match[1]);if(Math.abs(n)>100||match[2]&&n<0)throw Error('Pan Must Be From 100L To 100R.');return (match[2]==='l'?-n:n)/100;
}
export function nudgeMixerValue(kind,value,direction,{fine=false,large=false}={}){
 finite(value,kind==='volume'?0:-1,1);if(![1,-1].includes(direction))throw Error('Invalid mixer direction.');
 if(kind==='volume'){if(value===0)return direction>0?10**(-60/20):0;const db=20*Math.log10(value)+direction*(fine?.1:large?6:1);return direction<0&&db<-96?0:10**(Math.min(0,db)/20);}
 return Math.max(-1,Math.min(1,Math.round((value+direction*(fine?.001:large?.1:.01))*1000000)/1000000));
}
export function syncMixerReadout(slider){
 const field=slider?.parentElement?.querySelector('[data-mix-value]');if(!field)return;
 const text=mixerValueText(field.dataset.mixValue,Number(slider.value));slider.setAttribute('aria-valuetext',text);
 if(slider.ownerDocument?.activeElement!==field)field.value=text;
}
export function installMixerValueEditors(host,{locked=()=>false,error=()=>{}}={}){
 const readout=el=>el?.matches?.('[data-mix-value]')?el:null;
 const range=el=>el?.parentElement?.querySelector('[data-mix-range]');
 const sync=slider=>{const field=slider?.parentElement?.querySelector('[data-mix-value]');syncMixerReadout(slider);if(field)field.value=mixerValueText(field.dataset.mixValue,Number(slider.value));};
 const apply=(slider,value)=>{
  if(locked()||slider.disabled)throw Error('Finish The Current Operation Before Editing The Mixer.');if(Number(slider.value)===value){sync(slider);return;}
  const focused=slider.ownerDocument?.activeElement===slider,index=focused?[...host.querySelectorAll('[data-mix-range]')].indexOf(slider):-1;
  slider.value=String(value);slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}));sync(slider);
  // Project commits rebuild stopped mixer channels. Keep keyboard editing on its fader.
  if(focused&&!slider.isConnected)host.querySelectorAll('[data-mix-range]')[index]?.focus({preventScroll:true});
 };
 host.addEventListener('focusin',e=>{const field=readout(e.target);if(field){field.dataset.originalText=field.value;field.select();}});
 host.addEventListener('input',e=>{if(readout(e.target))e.stopImmediatePropagation();else if(e.target.matches?.('[data-mix-range]'))syncMixerReadout(e.target);},true);
 host.addEventListener('change',e=>{
  const field=readout(e.target);if(!field)return;e.stopImmediatePropagation();const slider=range(field);
  try{if(field.value!==field.dataset.originalText)apply(slider,parseMixerValue(field.dataset.mixValue,field.value));else sync(slider);}catch(err){sync(slider);error(err.message);}field.dataset.originalText=field.value;
 },true);
 host.addEventListener('keydown',e=>{
  const field=readout(e.target),slider=field?range(field):e.target.matches?.('[data-mix-range]')?e.target:null;if(!slider)return;
  if(field&&e.key==='Escape'){e.preventDefault();e.stopPropagation();sync(slider);field.dataset.originalText=field.value;field.blur();return;}
  if(field&&e.key==='Enter'){e.preventDefault();e.stopPropagation();field.dispatchEvent(new Event('change',{bubbles:true}));field.blur();return;}
  if(!field&&['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End'].includes(e.key)){
   e.preventDefault();e.stopPropagation();try{const kind=slider.dataset.mixRange,value=Number(slider.value),next=e.key==='Home'?(kind==='volume'?0:-1):e.key==='End'?1:nudgeMixerValue(kind,value,['ArrowUp','ArrowRight','PageUp'].includes(e.key)?1:-1,{fine:e.shiftKey,large:e.key.startsWith('Page')});apply(slider,next);}catch(err){error(err.message);}
  }
 });
 host.addEventListener('dblclick',e=>{if(!e.target.matches?.('[data-mix-range]'))return;e.preventDefault();try{apply(e.target,e.target.dataset.mixRange==='volume'?1:0);}catch(err){error(err.message);}});
}
