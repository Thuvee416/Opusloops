import {createRenderSnapshot,closeRenderSnapshot} from './render-snapshot.js';
import {deliveryOptions,deliveryDescription} from './delivery-options.js';
import {exportChannel} from './export-channel.js';
export async function renderWavSnapshot(source,options={}, {signal,createEngine}={}){
 signal?.throwIfAborted();const settings=deliveryOptions(source.project,options),engine=createRenderSnapshot(source,{createEngine});
 try{
  const output=exportChannel(engine.project,settings.channel),effective=settings.source==='auto'?(engine.project.arrangement.length?'arrangement':'session'):settings.source;
  const stem=engine.project.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,70)||'session';
  const filename=stem+(output.type==='master'?'':'-'+output.type+'-'+output.name.replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,50))+'.wav';
  const data=await engine.render(settings,{signal});signal?.throwIfAborted();
  return {data,filename,delivery:{format:'wav',settings,source:effective,channel:output.name},description:deliveryDescription(settings,effective,output.name)};
 }finally{await closeRenderSnapshot(engine);}
}
