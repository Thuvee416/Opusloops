import {envelopeValue,validateAutomation} from './automation.js';
import {automationChannels,automationTargets} from './automation-targets.js';
import {timelineBeat} from './transport.js';
const edge=1e-6;
function curveAt(envelope,beat){let curve='step';if(envelope?.enabled)for(const p of envelope.points){if(p.beat>beat)break;curve=p.curve;}return curve;}
// Replace only the played span. Guard points preserve the surrounding curve;
// input events are steps so a stationary control does not acquire a long ramp.
export function recordedEnvelope(base,start,end,samples,fallback,spec){
  const points=base?.enabled?structuredClone(base.points):[];
  const result=points.filter(p=>p.beat<start-edge||p.beat>end+edge);
  if(start>0){const beat=Math.max(0,start-edge);result.push({beat,value:envelopeValue(base,beat,fallback),curve:'step'});}
  for(const p of samples)if(p.beat<=end)result.push({...p,curve:'step'});
  if(end>start)result.push({beat:end,value:samples.at(-1).value,curve:'step'});
  if(end<16384){const beat=Math.min(16384,end+edge);result.push({beat,value:envelopeValue(base,beat,fallback),curve:curveAt(base,beat)});}
  const envelope={enabled:true,points:[...new Map(result.map(p=>[p.beat,p])).values()].sort((a,b)=>a.beat-b.beat)};
  validateAutomation({record:envelope},{record:spec});return envelope;
}
export class AutomationTake {
  constructor(project,raw,mode='latch'){if(!['latch','touch'].includes(mode))throw new Error('Choose Latch or Touch recording.');this.mode=mode;this.project=project;this.transport=structuredClone(project.transport);this.raw=raw;this.targets=new Map(automationChannels(project).flatMap(t=>automationTargets(t,project.returns).filter(a=>a.enabled).map(a=>[t.id+':'+a.key,{...a,fallback:a.fallback}])));this.writing=new Map();}
  write(trackId,key,value,raw){
    this.advance(raw);const id=trackId+':'+key,target=this.targets.get(id);if(!target)return false;
    if(!Number.isFinite(value)||value<target.spec.min||value>target.spec.max)throw new Error('Invalid recorded parameter value.');
    const beat=timelineBeat(Math.min(16384,raw),this.transport),old=this.writing.get(id);
    const state=old||{target,start:beat,raw,samples:[],base:structuredClone(target.owner.automation?.[target.paramKey])};
    const samples=state.samples.filter(p=>p.beat!==beat);if(!samples.length||samples.at(-1).value!==value)samples.push({beat,value});
    const envelope=recordedEnvelope(state.base,state.start,beat,samples,target.fallback,target.spec);
    state.samples=samples;this.writing.set(id,state);target.owner.automation??={};target.owner.automation[target.paramKey]=envelope;return true;
  }
  release(trackId,key,raw){if(this.mode!=='touch')return false;const id=trackId+':'+key;if(!this.writing.has(id))return false;this.advance(raw);this.writing.delete(id);return true;}
  advance(raw){
    raw=Math.min(16384,Math.max(this.raw,raw));
    for(const state of this.writing.values()){
      const t=this.transport;
      while(state.raw<raw){
        const start=timelineBeat(state.raw,t),untilWrap=t.loopEnabled?t.loopEnd-start:Infinity,step=Math.min(raw-state.raw,untilWrap),end=start+step;
        const envelope=recordedEnvelope(state.base,state.start,end,state.samples,state.target.fallback,state.target.spec);
        state.target.owner.automation[state.target.paramKey]=envelope;state.raw+=step;
        if(t.loopEnabled&&step===untilWrap){state.start=t.loopStart;state.base=structuredClone(envelope);state.samples=[{beat:t.loopStart,value:state.samples.at(-1).value}];}
      }
    }
    this.raw=raw;
  }
}
