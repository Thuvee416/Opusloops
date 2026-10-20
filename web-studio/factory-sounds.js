import {newSynth} from './instruments.js';
import {newDrumRack} from './drums.js';
import {newDevice} from './devices.js';
const effect=(type,params)=>{const d=newDevice(type);Object.assign(d.params,params);return d;};
export const FACTORY_SOUNDS=['Club Kick','Room Clap','Silk Hats','Night Percussion','Round Sub','Obsidian Bass','Velvet Chords','Prism Pluck','Silver Arp','Horizon Pad','Analog Bass','Velvet Ensemble','Glass Pluck','Prismatic Arp','Air Pad'];
export function factorySound(name){
 if(!FACTORY_SOUNDS.includes(name))throw Error('Unknown Factory Sound.');
 let instrument,devices=[];
 if(FACTORY_SOUNDS.indexOf(name)<4){
  instrument=newDrumRack();for(const p of instrument.pads){p.level=.65;p.character='studio';}
  Object.assign(instrument.pads[0],{decay:.65,level:.95,tune:0});
  Object.assign(instrument.pads[2],{decay:.22,level:.45});Object.assign(instrument.pads[3],{decay:.24,level:.65,pan:.06});
  Object.assign(instrument.pads[6],{decay:.065,level:.5,pan:-.22});Object.assign(instrument.pads[10],{decay:.3,level:.42,pan:.25});
  Object.assign(instrument.pads[14],{decay:.095,level:.35,pan:.4});Object.assign(instrument.pads[1],{level:.45,pan:-.35});
  Object.assign(instrument.pads[5],{decay:.19,tune:-5,level:.6,pan:.25});
  devices=name==='Club Kick'?[effect('eq',{low:2,mid:-3,high:-6})]:name==='Room Clap'?[effect('eq',{low:-12,mid:1,high:1}),effect('reverb',{decay:.4,mix:.1})]:name==='Silk Hats'?[effect('eq',{low:-18,mid:-4,high:-1})]:[effect('eq',{low:-8,mid:1,high:-4}),effect('delay',{time:60/104*.75,feedback:.2,mix:.12})];
 }else{
  instrument=newSynth(name);
  const eq=params=>effect('eq',{low:-12,mid:0,high:0,...params});
  if(name==='Round Sub')devices=[effect('filter',{frequency:180,q:.7})];
  if(name==='Obsidian Bass')devices=[effect('drive',{drive:2,mix:.12}),eq({low:-5,mid:1,high:-8})];
  if(name==='Velvet Chords')devices=[eq({low:-18,mid:-2,high:-2}),effect('chorus',{mix:.15,depth:1.5,rate:.3}),effect('reverb',{decay:1.5,mix:.15})];
  if(name==='Prism Pluck')devices=[eq({low:-18,high:-2}),effect('delay',{time:60/104*.75,feedback:.3,mix:.23}),effect('reverb',{decay:1.4,mix:.12})];
  if(name==='Silver Arp')devices=[eq({low:-24,mid:-3,high:-3}),effect('delay',{time:60/104*.5,feedback:.3,mix:.25}),effect('autopan',{amount:25,rate:.43})];
  if(name==='Analog Bass')devices=[effect('parametric',{lowCut:48,lowGain:-2,midFrequency:400,midGain:-2,highCut:6500})];
  if(name==='Velvet Ensemble')devices=[effect('parametric',{lowCut:220,midFrequency:500,midGain:-2,highGain:1}),effect('chorus',{mix:.18,depth:1.4,rate:.25}),effect('space',{decay:2.1,preDelay:.025,mix:.18})];
  if(name==='Glass Pluck')devices=[effect('parametric',{lowCut:300,midFrequency:3100,midGain:-2.5,midQ:1.1,highGain:-2}),effect('echo',{time:60/104*.75,feedback:.36,mix:.23,damping:4600}),effect('space',{decay:2.6,mix:.13})];
  if(name==='Prismatic Arp')devices=[effect('parametric',{lowCut:500,highGain:-2}),effect('echo',{time:60/104*.5,feedback:.28,mix:.22,damping:6500})];
  if(name==='Air Pad')devices=[effect('parametric',{lowCut:400,midFrequency:1800,midGain:-2,highGain:-3}),effect('chorus',{mix:.25,depth:2.3,rate:.18}),effect('space',{decay:3.2,mix:.25,lowCut:400,damping:5800})];
  if(name==='Horizon Pad')devices=[eq({low:-24,mid:-2,high:-5}),effect('chorus',{mix:.22,depth:2,rate:.2}),effect('reverb',{decay:2.2,mix:.25})];
 }
 const trims={'Club Kick':-6,'Room Clap':12,'Silk Hats':8,'Night Percussion':8,'Round Sub':-6,'Obsidian Bass':4,'Velvet Chords':13,'Prism Pluck':16,'Silver Arp':18,'Horizon Pad':16,'Analog Bass':1,'Velvet Ensemble':8,'Glass Pluck':6,'Prismatic Arp':12,'Air Pad':10};
 devices.push(effect('utility',{gain:trims[name]}));
 return {format:'opus-sound',version:1,name,instrument,devices,midiEffects:[]};
}
export function factorySoundItems(){return FACTORY_SOUNDS.map(name=>{const p=factorySound(name);return {id:'factory:'+name,name,instrument:p.instrument.type,effects:p.devices.length,midiEffects:0,factory:true};});}
