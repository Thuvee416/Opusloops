const {test}=require('node:test'),assert=require('node:assert/strict');

test('the factory demo is an editable eight-bar arrangement with independent scenes and no reference media',async()=>{
 const {createDemoSession,DEMO_BEATS}=await import('../web-studio/demo-session.js'),{validateProject}=await import('../web-studio/model.js');
 const p=createDemoSession();validateProject(JSON.parse(JSON.stringify(p)));assert.equal(p.tracks.length,10);assert.equal(p.arrangement.length,40);assert.equal(p.transport.loopEnd,DEMO_BEATS);assert.equal(p.transport.loopEnabled,true);assert.ok(DEMO_BEATS*60/p.bpm>18&&DEMO_BEATS*60/p.bpm<21);
 assert.equal(p.locators.length,4);assert.ok(Object.values(p.clips).reduce((n,c)=>n+c.notes.length,0)>450);
 for(const t of p.tracks){assert.ok(t.instrument);assert.ok(t.devices.length);assert.equal(new Set(t.slots).size,4);const regions=p.arrangement.filter(r=>r.trackId===t.id).sort((a,b)=>a.start-b.start);assert.deepEqual(regions.map(r=>r.start),[0,8,16,24]);for(const r of regions){assert.equal(r.length,8);const c=p.clips[r.clipId];assert.equal(c.kind,'midi');assert.equal(c.data,undefined);assert.equal(c.beats,8);for(const n of c.notes)assert.ok(n.start+n.duration<=8);}}
 const next=createDemoSession();p.tracks[0].instrument.pads[0].level=0;assert.notEqual(next.tracks[0].instrument.pads[0].level,0);assert.notEqual(p.tracks[0].id,next.tracks[0].id);
});

test('factory sounds load through the shared preset path and retain clips and mixer state',async()=>{
 const {FACTORY_SOUNDS}=await import('../web-studio/factory-sounds.js'),{getSoundPreset,applySoundPreset,removeSoundPreset}=await import('../web-studio/sound-presets.js'),{emptyProject,validateProject}=await import('../web-studio/model.js');
 for(const name of FACTORY_SOUNDS){const p=emptyProject(),before=structuredClone(p),sound=await getSoundPreset('factory:'+name),next=applySoundPreset(p,p.tracks[0].id,sound);validateProject(next);assert.deepEqual(p,before);assert.equal(next.tracks[0].volume,p.tracks[0].volume);assert.deepEqual(next.clips,p.clips);assert.notEqual(next.tracks[0].devices[0].id,sound.devices[0].id);await assert.rejects(removeSoundPreset('factory:'+name),/Cannot Be Removed/);}
});

test('old synth projects remain valid while new controls have bounded integer voices and continuous ranges',async()=>{
 const {newSynth,validateInstrument}=await import('../web-studio/instruments.js'),{ENSEMBLE_PARAMS}=await import('../web-studio/ensemble-voice.js');const old=newSynth();for(const k of Object.keys(ENSEMBLE_PARAMS))delete old[k];validateInstrument(old);
 for(const [key,value]of [['unison',2.5],['unison',6],['width',1.1],['spread',NaN],['filterEnv',5],['filterDecay',0],['sub',-1]])assert.throws(()=>validateInstrument({...newSynth('Velvet Chords'),[key]:value}));
});

function context(failAt=Infinity){let calls=0;const nodes=[],param=()=>({value:0,events:[],setValueAtTime(v,t){this.events.push([v,t]);},linearRampToValueAtTime(v,t){this.events.push([v,t]);},exponentialRampToValueAtTime(v,t){this.events.push([v,t]);},cancelScheduledValues(){},cancelAndHoldAtTime(){}}),node=kind=>{if(++calls===failAt)throw Error('Allocation');const n={kind,gain:param(),frequency:param(),detune:param(),pan:param(),Q:param(),connected:false,connect(){this.connected=true;},disconnect(){this.connected=false;},starts:[],stops:[],start(t){this.starts.push(t);},stop(t){this.stops.push(t);}};nodes.push(n);return n;};return {nodes,currentTime:0,sampleRate:44100,createGain:()=>node('gain'),createOscillator:()=>node('osc'),createBiquadFilter:()=>node('filter'),createStereoPanner:()=>node('pan')};}

test('stopping an ensemble through the engine-owned oscillator stops and cleans every layer',async()=>{
 const {newSynth,synthVoice}=await import('../web-studio/instruments.js'),ctx=context(),s={...newSynth('Velvet Chords'),sub:.3},voice=synthVoice(ctx,{},s,60,.8,0,1);
 const oscillators=ctx.nodes.filter(n=>n.kind==='osc');assert.equal(oscillators.length,4);assert.ok(oscillators.every(n=>n.starts.length===1&&n.stops.length===1));
 voice.osc.stop(.2);assert.ok(oscillators.every(n=>n.stops.at(-1)===.2));voice.osc.onended();assert.ok(ctx.nodes.every(n=>!n.connected));
});

test('ensemble allocation failure releases partial graphs, and chased filter envelopes retain their phase',async()=>{
 const {newSynth,synthVoice}=await import('../web-studio/instruments.js');for(const count of [2,5,11,13]){const ctx=context(count);assert.throws(()=>synthVoice(ctx,{},newSynth('Velvet Chords'),60,.8,0,1),/Allocation/);assert.ok(ctx.nodes.every(n=>!n.connected));}
 const ctx=context(),s=newSynth('Prism Pluck');synthVoice(ctx,{},s,72,.7,2,.2,s.filterDecay/2);const value=ctx.nodes.find(n=>n.kind==='filter').frequency.events[0][0];assert.ok(Math.abs(value-s.cutoff*2**(s.filterEnv/2))<1e-6);
});
