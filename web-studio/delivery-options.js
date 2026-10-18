import {exportOptions} from './wav-export.js';
import {exportChannel} from './export-channel.js';
import {exportRangePlan} from './export-range.js';

// One delivery contract for the export dialog, agent preflight and runtime.
export const DELIVERY_KEYS=['source','sampleRate','bitDepth','normalize','dither','includeTail','range'];
export function deliveryOptions(project,options={},kind='wav'){
 if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Expected export settings.');
 const keys=[...DELIVERY_KEYS,...(kind==='wav'?['channel']:[])];
 if(Object.keys(options).some(key=>!keys.includes(key)))throw new Error('Unsupported '+kind+' export setting.');
 const value=exportOptions({bitDepth:24,includeTail:true,...options});
 if(typeof value.includeTail!=='boolean')throw new Error('Choose whether to include effect tails.');
 if(value.range!==undefined){
  if(!value.range||typeof value.range!=='object'||Array.isArray(value.range)||Object.keys(value.range).some(key=>!['start','length'].includes(key)))throw new Error('Choose a valid Arrangement export range.');
  if(value.source==='session')throw new Error('Session snapshot exports do not accept an Arrangement range.');
  value.source='arrangement';
  exportRangePlan([],project.bpm,value.sampleRate,0,value.range,value.includeTail);
 }
 if(value.source==='arrangement'&&!project.arrangement.length)throw new Error('Add Arrangement clips before exporting the Arrangement.');
 if(kind==='wav'){
  value.channel=value.channel===undefined?'master':value.channel;
  exportChannel(project,value.channel);
 }
 return structuredClone(value);
}
export function deliveryDescription(settings,effectiveSource,channel){
 const format=settings.bitDepth===32?'32-bit float':settings.bitDepth+'-bit PCM';
 const range=settings.range?`beats ${settings.range.start+1}–${settings.range.start+settings.range.length+1}`:effectiveSource==='session'?'four-bar Session snapshot':'whole Arrangement';
 return `${settings.sampleRate/1000} kHz, ${format}, ${range}, effect tails ${settings.includeTail?'included':'excluded'}${channel?', '+channel:''}.`;
}
