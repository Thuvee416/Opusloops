import {Engine} from './audio.js';
import {analysisRange} from './production-analysis.js';
export async function observeProduction(project,signal){
 signal.throwIfAborted();const range=analysisRange(project);if(!range)return {version:1,status:'unavailable',reason:'Add Arrangement material to measure processed output. Session clips are not silently substituted.'};
 const snapshot=structuredClone(project),renderEngine=new Engine(snapshot,()=>{});
 try{
  await renderEngine.init(false);signal.throwIfAborted();
  const bytes=await renderEngine.render({source:'arrangement',range,channel:'master',sampleRate:44100,bitDepth:32,normalize:false,dither:'none',includeTail:false});signal.throwIfAborted();
  const result=await new Promise((resolve,reject)=>{const worker=new Worker(new URL('./production-analysis-worker.js',import.meta.url),{type:'module'});const finish=(error,value)=>{worker.terminate();signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};const abort=()=>finish(signal.reason||new DOMException('Canceled','AbortError'));signal.addEventListener('abort',abort,{once:true});worker.onmessage=e=>finish(e.data.error?Error(e.data.error):null,e.data.result);worker.onerror=()=>finish(Error('Audio analysis worker failed.'));worker.postMessage(bytes,[bytes]);if(signal.aborted)abort();});
  return {version:1,status:'measured',stage:'post-master including effects, instruments, routing and Arrangement automation',range,coverage:'Opening excerpt only; not whole-song or reference analysis',...result};
 }finally{await renderEngine.context?.close();}
}
