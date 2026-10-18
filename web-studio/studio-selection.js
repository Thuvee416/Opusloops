// View state only. The same selectors validate manual and agent navigation.
export const SELECTION_KEYS=['target','trackId','clipId','scene','ids','primaryId'];
export const DETAIL_PANELS=['clip','devices','recording','returns'];
const fail=message=>{throw new Error(message);};
export function selectionIntent(project,args){
 if(!args||typeof args!=='object'||Array.isArray(args))fail('Expected selection arguments.');
 const allowed={track:['target','trackId'],clip:['target','trackId','clipId','scene'],regions:['target','ids','primaryId']}[args.target];
 if(!allowed)fail('Select target track, clip or regions.');
 const extra=Object.keys(args).filter(key=>!allowed.includes(key));if(extra.length)fail('Unsupported '+args.target+' selection fields: '+extra.join(', ')+'.');
 if(args.target==='track'){
  const track=[...project.tracks,...project.returns||[]].find(t=>t.id===args.trackId);if(!track)fail('Choose an existing track or return for its devices.');
  return {target:'track',trackId:track.id};
 }
 if(args.target==='clip'){
  const track=project.tracks.find(t=>t.id===args.trackId);if(!track)fail('Choose the regular track that owns the Session clip.');
  let scene=args.scene;
  if(scene===undefined){
   if(typeof args.clipId!=='string')fail('Choose a Session clipId or zero-based scene.');
   const slots=track.slots.flatMap((id,index)=>id===args.clipId?[index]:[]);
   if(slots.length!==1)fail(slots.length?'This clip occupies multiple Session slots; specify its zero-based scene.':'That clip is not in this track’s Session slots.');scene=slots[0];
  }
  if(!Number.isInteger(scene)||scene<0||scene>=project.scenes)fail('Choose a valid zero-based Session scene.');
  const clipId=track.slots[scene];if(!clipId||!project.clips[clipId])fail('Empty Session slot on trackId '+track.id+': scene='+scene+' (displayed scene '+(scene+1)+'). Available zero-based scene indices: '+track.slots.flatMap((id,index)=>id&&project.clips[id]?[index]:[]).join(', ')+'. Displayed scene 2 means scene=1.');
  if(args.clipId!==undefined&&args.clipId!==clipId)fail('The Session scene does not contain that clipId.');
  return {target:'clip',trackId:track.id,clipId,scene};
 }
 if(!Array.isArray(args.ids)||!args.ids.length||args.ids.length>512||new Set(args.ids).size!==args.ids.length||args.ids.some(id=>typeof id!=='string'||!project.arrangement.some(r=>r.id===id)))fail('Choose 1–512 unique existing Arrangement region IDs.');
 const primaryId=args.primaryId??args.ids[0];if(!args.ids.includes(primaryId))fail('The primary region must be in the selected region IDs.');
 return {target:'regions',ids:[...args.ids],primaryId};
}
export function detailPanelIntent(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='panel')||!DETAIL_PANELS.includes(args.panel))fail('Choose detail panel clip, devices, recording or returns.');
 return args.panel;
}
export function describeNavigation(result){
 if(result.target==='track')return 'Showing devices for '+result.trackName+'.';
 if(result.target==='clip')return 'Selected '+result.clipName+' on '+result.trackName+', scene '+(result.selection.scene+1)+'. Clip view open.';
 if(result.target==='regions')return 'Selected '+result.selectedRegions.length+' Arrangement '+(result.selectedRegions.length===1?'clip':'clips')+'. '+result.clipName+' is primary. Clip view open.';
 return 'Showing '+result.detailPanel+' detail panel.';
}
