// Sparse, per-placement state. Source clips may also belong to other slots/Arrangement.
export const SLOT_METADATA=['noStopSlots','inactiveSlots'];
export const slotActive=(track,scene)=>!track.inactiveSlots?.includes(scene);
export function setSlotActive(track,scene,active){
 if(typeof active!=='boolean'||!Number.isInteger(scene)||scene<0||scene>=track.slots.length||!active&&!track.slots[scene])throw new Error('Choose an occupied Session slot and an activation state.');
 const values=(track.inactiveSlots||[]).filter(i=>i!==scene);if(!active)values.push(scene);if(values.length)track.inactiveSlots=values.sort((a,b)=>a-b);else delete track.inactiveSlots;
}
export function remapSlotMetadata(track,map){for(const key of SLOT_METADATA)if(track[key]){const values=[...new Set(track[key].flatMap(i=>{const next=map(i);return next===null||next===undefined?[]:[next];}))].sort((a,b)=>a-b);if(values.length)track[key]=values;else delete track[key];}}
export function insertSlotMetadata(track,index,copyFrom){const copied=SLOT_METADATA.filter(key=>copyFrom!==undefined&&track[key]?.includes(copyFrom));remapSlotMetadata(track,i=>i>=index?i+1:i);for(const key of copied)track[key]=[...track[key]||[],index].sort((a,b)=>a-b);}
export function validateSlotMetadata(track,scenes){for(const key of SLOT_METADATA)if(track[key]!==undefined&&(!Array.isArray(track[key])||new Set(track[key]).size!==track[key].length||track[key].some(i=>!Number.isInteger(i)||i<0||i>=scenes||key==='inactiveSlots'&&!track.slots[i])))throw new Error('Invalid Session slot metadata.');}
