import {uid,validateProject} from './model.js';
import {envelopeValue} from './automation.js';
import {automationChannels,automationTargets} from './automation-targets.js';
export function mapTime(beat,action,start,length){return action==='insert'?(beat>=start?beat+length:beat):(beat>=start+length?beat-length:Math.min(beat,start));}
export function curveAt(points,beat){let curve='step';for(const p of points){if(p.beat>beat)break;curve=p.curve;}return curve;}
export function shiftEnvelope(envelope,action,start,length){
  if(!envelope?.points.length)return structuredClone(envelope);
  const active={...envelope,enabled:true},points=envelope.points,end=start+length,at=b=>envelopeValue(active,b,0),next=points.filter(p=>p.beat<start).map(p=>({...p}));
  // A short guard preserves the incoming segment up to a discontinuous splice.
  const previous=next.at(-1)?.beat??0,guard=start>0?start-Math.min(1e-6,(start-previous)/2):0;
  if(start>0)next.push({beat:guard,value:at(guard),curve:curveAt(points,guard)});
  if(action==='insert'){
    const held=start>0?at(guard):at(start);next.push({beat:start,value:held,curve:'step'},{beat:end,value:at(start),curve:curveAt(points,start)});
    next.push(...points.filter(p=>p.beat>start).map(p=>({...p,beat:p.beat+length})));
  }else{
    next.push({beat:start,value:at(end),curve:curveAt(points,end)});
    next.push(...points.filter(p=>p.beat>end).map(p=>({...p,beat:p.beat-length})));
  }
  return {...envelope,points:next};
}
export function validateTimeRange(start,length){
  if(!Number.isFinite(start)||!Number.isFinite(length)||start<0||length<.25||start+length>16384||start*4%1||length*4%1)throw new Error('Use quarter-beat positions and a time range of at least 0.25 beats within beats 1–16385.');
}
export function editArrangementTime(project,action,start,length){
  if(!['insert','delete'].includes(action))throw new Error('Choose Insert or Delete time.');validateTimeRange(start,length);
  const next=structuredClone(project),end=start+length,move=beat=>mapTime(beat,action,start,length);
  next.arrangement=project.arrangement.flatMap(r=>{const stop=r.start+r.length;if(stop<=start)return [{...r}];if(action==='insert'){
    if(r.start>=start)return [{...r,start:r.start+length}];
    return [{...r,length:start-r.start},{...r,id:uid(),start:end,length:stop-start,offset:r.offset+start-r.start}];
  }
  if(r.start>=end)return [{...r,start:r.start-length}];
  const parts=[];if(r.start<start)parts.push({...r,length:start-r.start});if(stop>end)parts.push({...r,id:parts.length?uid():r.id,start,offset:r.offset+end-r.start,length:stop-end});return parts;
  });
  if(next.locators)next.locators=next.locators.filter(l=>action==='insert'||l.beat<start||l.beat>=end).map(l=>({...l,beat:move(l.beat)}));
  for(const channel of automationChannels(next))for(const target of automationTargets(channel,next.returns)){if(!target.envelope)continue;target.owner.automation={...target.owner.automation,[target.paramKey]:shiftEnvelope(target.envelope,action,start,length)};}
  if(next.transport){const t=next.transport;t.loopStart=move(t.loopStart);t.loopEnd=move(t.loopEnd);if(t.loopEnd-t.loopStart<.25){t.loopEnabled=false;t.loopStart=Math.min(t.loopStart,16383.75);t.loopEnd=t.loopStart+.25;}}
  if(next.arrangement.some(r=>r.start+r.length>16384))throw new Error('The edit would move regions past the timeline limit.');
  validateProject(next);return next;
}

export function duplicateArrangementTime(project,start,length){
  // Inserting after the source preserves the original half-open range and
  // shifts later material before we populate the new span.
  if(!Number.isFinite(start)||start<0||start*4%1)throw new Error('Choose a valid quarter-beat start.');
  const end=start+length,next=editArrangementTime(project,'insert',end,length);
  for(const r of project.arrangement){const from=Math.max(start,r.start),to=Math.min(end,r.start+r.length);if(to<=from)continue;if(Object.keys(next.clips).length>=512)throw new Error('Duplicating this passage would exceed the 512-clip limit.');const clip=structuredClone(project.clips[r.clipId]);clip.id=uid();next.clips[clip.id]=clip;next.arrangement.push({...r,id:uid(),clipId:clip.id,start:from+length,length:to-from,offset:r.offset+from-r.start});}
  if(project.locators){next.locators.push(...project.locators.filter(l=>l.beat>=start&&l.beat<end).map(l=>({...l,id:uid(),beat:l.beat+length})));next.locators.sort((a,b)=>a.beat-b.beat);}
  const originals=new Map(automationChannels(project).map(c=>[c.id,c]));
  for(const channel of automationChannels(next)){const sourceTargets=new Map(automationTargets(originals.get(channel.id),project.returns).map(t=>[t.key,t]));for(const target of automationTargets(channel,next.returns)){
    const source=sourceTargets.get(target.key)?.envelope;if(!source?.points.length)continue;
    const active={...source,enabled:true},at=b=>envelopeValue(active,b,0),inside=source.points.filter(p=>p.beat>start&&p.beat<end),last=inside.at(-1)?.beat??start,guard=end-Math.min(1e-6,(end-last)/2);
    const copied=[{beat:end,value:at(start),curve:curveAt(source.points,start)},...inside.map(p=>({...p,beat:p.beat+length})),{beat:guard+length,value:at(guard),curve:curveAt(source.points,guard)}];
    const points=[...target.envelope.points.filter(p=>p.beat<end||p.beat>=end+length),...copied].sort((a,b)=>a.beat-b.beat);
    target.owner.automation={...target.owner.automation,[target.paramKey]:{...source,points}};
  }}
  validateProject(next);return next;
}
