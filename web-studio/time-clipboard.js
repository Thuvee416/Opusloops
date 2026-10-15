import {uid,validateProject} from './model.js';
import {envelopeValue} from './automation.js';
import {automationChannels,automationTargets} from './automation-targets.js';
import {editArrangementTime,curveAt,validateTimeRange} from './time-edit.js';
function sliceEnvelope(envelope,start,length){
 const end=start+length,active={...envelope,enabled:true},at=beat=>envelopeValue(active,beat,0),inside=envelope.points.filter(p=>p.beat>start&&p.beat<end),last=inside.at(-1)?.beat??start,guard=end-Math.min(1e-6,(end-last)/2);
 return {enabled:envelope.enabled,points:[{beat:0,value:at(start),curve:curveAt(envelope.points,start)},...inside.map(p=>({...p,beat:p.beat-start})),{beat:guard-start,value:at(guard),curve:curveAt(envelope.points,guard)}]};
}
export function copyArrangementTime(project,start,length){
 validateTimeRange(start,length);validateProject(project);const end=start+length,regions=[],clips={},automation=[];
 for(const r of project.arrangement){const from=Math.max(start,r.start),to=Math.min(end,r.start+r.length);if(to<=from)continue;regions.push({...r,start:from-start,length:to-from,offset:r.offset+from-r.start});clips[r.clipId]=structuredClone(project.clips[r.clipId]);}
 for(const channel of automationChannels(project))for(const target of automationTargets(channel,project.returns))if(target.envelope?.points.length)automation.push({channelId:channel.id,key:target.key,envelope:sliceEnvelope(target.envelope,start,length)});
 const locators=(project.locators||[]).filter(l=>l.beat>=start&&l.beat<end).map(l=>({...l,beat:l.beat-start}));
 // Reject fragments shorter than the project's supported Arrangement precision.
 validateProject({...project,arrangement:regions});
 return {version:1,length,regions,clips,automation,locators};
}
export function pasteArrangementTime(project,clipboard,start){
 if(!clipboard||clipboard.version!==1)throw new Error('Copy or cut an Arrangement time range first.');
 validateTimeRange(start,clipboard.length);const next=editArrangementTime(project,'insert',start,clipboard.length),end=start+clipboard.length,channels=new Map(automationChannels(next).map(t=>[t.id,t])),trackIds=new Set(next.tracks.map(t=>t.id)),clipIds=new Map();
 for(const r of clipboard.regions){if(!trackIds.has(r.trackId))throw new Error('A copied track was removed. Restore it or copy another range.');let id=clipIds.get(r.clipId);if(!id){const clip=structuredClone(clipboard.clips[r.clipId]);if(!clip)throw new Error('The copied clip is unavailable.');id=uid();clip.id=id;clipIds.set(r.clipId,id);next.clips[id]=clip;}next.arrangement.push({...r,id:uid(),clipId:id,start:start+r.start});}
 if(clipboard.locators.length){next.locators??=[];next.locators.push(...clipboard.locators.map(l=>({...l,id:uid(),beat:start+l.beat})));next.locators.sort((a,b)=>a.beat-b.beat);}
 for(const entry of clipboard.automation){const channel=channels.get(entry.channelId),target=channel&&automationTargets(channel,next.returns).find(t=>t.key===entry.key);if(!target)throw new Error('A copied automation track, device or return was removed. Restore it or copy another range.');
  const existing=target.envelope,points=(existing?.points||[]).filter(p=>p.beat<start||p.beat>=end).map(p=>({...p}));
  if(!existing?.points.length){if(start>0)points.push({beat:0,value:target.fallback,curve:'step'},{beat:start-Math.min(1e-6,start/2),value:target.fallback,curve:'step'});points.push({beat:end,value:target.fallback,curve:'step'});}
  points.push(...entry.envelope.points.map(p=>({...p,beat:start+p.beat})));points.sort((a,b)=>a.beat-b.beat);
  target.owner.automation={...target.owner.automation,[target.paramKey]:{enabled:existing?.enabled??entry.envelope.enabled,points}};
 }
 validateProject(next);return next;
}
