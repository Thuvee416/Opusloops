import {validateProject} from './model.js';
import {sliceRegion,regionsCanOverlap,validateRegionFades} from './region-fades.js';
const phase=(n,beats)=>((n%beats)+beats)%beats;
export function crossfadePairInfo(project,leftId,rightId){
 const left=project.arrangement.find(r=>r.id===leftId),right=project.arrangement.find(r=>r.id===rightId);
 if(!left||!right||left===right||left.trackId!==right.trackId||left.start>=right.start||project.clips[left.clipId].kind==='midi'||project.clips[right.clipId].kind==='midi')throw new Error('Choose two ordered audio/generated-loop regions on the same track.');
 const leftEnd=left.start+left.length,rightEnd=right.start+right.length;
 if(rightEnd<=leftEnd||right.start>leftEnd+1e-7||right.start<leftEnd-1e-7&&!regionsCanOverlap(left,right,project.clips))throw new Error('Choose adjacent regions or an existing complementary crossfade.');
 const overlap=Math.max(0,leftEnd-right.start),lc=project.clips[left.clipId],rc=project.clips[right.clipId],endPhase=phase(left.offset+left.length,lc.beats);
 const before=phase(right.offset,rc.beats),after=endPhase<1e-7?0:lc.beats-endPhase;
 let length=overlap||Math.min(1,before+after),start=overlap?right.start:leftEnd-Math.min(before,length/2);
 if(!overlap&&start+length>leftEnd+after)start=leftEnd+after-length;
 return {left,right,overlap,start,length,before,after};
}
export function editRegionCrossfade(project,options={}){
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['leftId','rightId','action','start','length','boundary'].includes(k)))throw new Error('Unsupported crossfade settings.');
 const {leftId,rightId,action='create',start,length,boundary}=options;
 const pair=crossfadePairInfo(project,leftId,rightId),{left,right}=pair;
 let a,b;
 if(action==='create'){
  if(boundary!==undefined||!Number.isFinite(start)||!Number.isFinite(length)||start<0||length<1e-6||start+length>16384)throw new Error('Choose a finite crossfade start and positive length in zero-based beats.');
  const end=start+length,leftEnd=left.start+left.length,rightEnd=right.start+right.length;
  if(start<left.start||end>rightEnd||start>leftEnd+1e-7||end<right.start-1e-7||end-left.start<.0625||rightEnd-start<.0625)throw new Error('The crossfade must cover the join and keep both regions in the timeline.');
  if(start<right.start-pair.before-1e-7||end>leftEnd+pair.after+1e-7)throw new Error('Not enough source audio at this join. Trim source edges to expose material; crossfades cannot cross a loop boundary.');
  a=sliceRegion(left,0,end-left.start);b=sliceRegion(right,start-right.start,rightEnd-start);
  const identity={start:0,end:0,from:1,to:1};
  a.fades={in:structuredClone(a.fades?.in??identity),out:{start:start-a.start,end:a.length,from:1,to:0}};
  b.fades={in:{start:0,end:length,from:0,to:1},out:structuredClone(b.fades?.out??identity)};
 }else if(action==='remove'){
  if(start!==undefined||length!==undefined||!pair.overlap)throw new Error('Choose an existing crossfade to remove; use boundary rather than start/length.');
  const at=boundary===undefined?right.start+pair.overlap/2:boundary;
  if(!Number.isFinite(at)||at<right.start||at>left.start+left.length||at-left.start<.0625||right.start+right.length-at<.0625)throw new Error('Choose a removal boundary inside the overlap.');
  a=sliceRegion(left,0,at-left.start);b=sliceRegion(right,at-right.start,right.start+right.length-at);
  const clear=(r,edge)=>{if(!r.fades)return;const f=r.fades;r.fades={...f,[edge]:{start:0,end:0,from:1,to:1}};if(Object.values(r.fades).every(v=>v.from===1&&v.to===1))delete r.fades;};clear(a,'out');clear(b,'in');
 }else throw new Error('Choose create or remove crossfade.');
 validateRegionFades(a,project.clips[a.clipId]);validateRegionFades(b,project.clips[b.clipId]);
 const updates=new Map([[a.id,a],[b.id,b]]),arrangement=project.arrangement.map(r=>updates.get(r.id)||r);
 validateProject({...project,arrangement});return {arrangement,observation:{type:'region_crossfade',action,leftId,rightId,start:action==='create'?start:b.start,length:action==='create'?length:0}};
}

export function crossfadePairs(project,trackId){
 const regions=project.arrangement.filter(r=>r.trackId===trackId).sort((a,b)=>a.start-b.start),pairs=[];
 for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length&&regions[j].start<regions[i].start+regions[i].length-1e-7;j++){
  const a=regions[i],b=regions[j];if(!regionsCanOverlap(a,b,project.clips))continue;
  const start=Math.max(a.start,b.start),end=Math.min(a.start+a.length,b.start+b.length);pairs.push({left:a,right:b,start,length:end-start});
 }
 return pairs;
}
