// Acyclic main-output routes. Sends remain separate edges into return tracks.
export const trackOutput=track=>track.output===undefined?'master':track.output;
export function trackRouting(project){
 const ids=new Set(project.tracks.map(t=>t.id));if(ids.size!==project.tracks.length)throw new Error('Track routing requires unique track IDs.');
 const destinations=new Map();
 for(const t of project.tracks){const output=trackOutput(t);if(['master','sendsOnly'].includes(output)){destinations.set(t.id,null);continue;}if(typeof output!=='string'||!output.startsWith('track:')||!ids.has(output.slice(6)))throw new Error('Choose Master, Sends Only or an existing regular track output.');if(output.slice(6)===t.id)throw new Error('A track cannot route its output to itself.');destinations.set(t.id,output.slice(6));}
 const state=new Map(),order=[];
 function visit(id){if(state.get(id)===1)throw new Error('Track output routing cannot contain a feedback loop.');if(state.get(id)===2)return;state.set(id,1);const target=destinations.get(id);if(target!==null)visit(target);state.set(id,2);order.push(id);}
 for(const id of ids)visit(id);return {destinations,order:order.reverse()};
}
export function routingSoloState(project,routes=trackRouting(project)){
 const solo=new Set(project.tracks.filter(t=>t.solo).map(t=>t.id)),own=new Set(),through=new Set();
 for(const t of project.tracks){let id=t.id,allowed=!solo.size;while(id!==null){if(solo.has(id))allowed=true;id=routes.destinations.get(id);}if(allowed)own.add(t.id);}
 for(const source of own){let id=source;while(id!==null){through.add(id);id=routes.destinations.get(id);}}
 return {own,through};
}
export function setTrackOutput(project,trackId,output){
 const track=project.tracks.find(t=>t.id===trackId);if(!track)throw new Error('Choose an existing regular track.');
 trackRouting({...project,tracks:project.tracks.map(t=>t===track?{...t,output}:t)});
 if(output===undefined)delete track.output;else track.output=output;
}
export function trackOutputChoices(project,trackId){
 const routes=trackRouting(project),canRoute=id=>{while(id!==null){if(id===trackId)return false;id=routes.destinations.get(id);}return true;};
 return [{value:'master',name:'Master',disabled:false},{value:'sendsOnly',name:'Sends Only',disabled:false},...project.tracks.filter(t=>t.id!==trackId).map(t=>({value:'track:'+t.id,name:t.name,disabled:!canRoute(t.id)}))];
}
export function routingInputs(project,trackId){return project.tracks.filter(t=>trackOutput(t)==='track:'+trackId).map(t=>t.id);}
export function trackRoutingChanges(before,after){
 const previous=new Map(before.tracks.map(t=>[t.id,trackOutput(t)]));return after.tracks.flatMap(t=>{const from=previous.get(t.id)??'master',to=trackOutput(t);if(from===to)return [];return [{type:'track_output',trackId:t.id,trackName:t.name,from,to,destinationName:to==='master'?'Master':to==='sendsOnly'?'Sends Only':after.tracks.find(target=>target.id===to.slice(6))?.name??'Missing track'}];});
}
export function initialTrackMix(track,args){for(const [key,min,max]of [['volume',0,1],['pan',-1,1]])if(args[key]!==undefined){if(!Number.isFinite(args[key])||args[key]<min||args[key]>max)throw new Error('Initial track '+key+' must be a number from '+min+' to '+max+'.');track[key]=args[key];}if(args.output!==undefined){if(typeof args.output!=='string'||!['master','sendsOnly'].includes(args.output)&&!/^track:.+/.test(args.output))throw new Error('Initial track output must be master, sendsOnly or track:ID.');track.output=args.output;}return track;}
