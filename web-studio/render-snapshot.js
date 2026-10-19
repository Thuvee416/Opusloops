import {Engine} from './audio.js';
// Export owns its render engine. Mutable Session state and automation overrides
// are captured together with project data, independently of ongoing playback.
export function createRenderSnapshot(source,{createEngine=project=>new Engine(project,()=>{})}={}){
 const project=structuredClone(source.project),engine=createEngine(project);
 engine.active=structuredClone(source.active??new Map());
 engine.automationOverrides=new Set(source.automationOverrides??[]);
 engine.masterVolume=source.masterVolume??project.master??.8;
 return engine;
}
export async function closeRenderSnapshot(engine){if(engine.context)await engine.context.close().catch(()=>{});}
