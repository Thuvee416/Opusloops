import {measureProductionPCM,readRenderedFloatWave} from './production-analysis.js';
self.onmessage=event=>{try{const {channels,sampleRate}=readRenderedFloatWave(event.data);self.postMessage({result:measureProductionPCM(channels,sampleRate)});}catch(error){self.postMessage({error:error.message});}};
