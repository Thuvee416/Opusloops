export const FOLLOW_ACTIONS={none:'No action',stop:'Stop',again:'Play again',previous:'Previous',next:'Next',first:'First',last:'Last',any:'Any',other:'Other',jump:'Jump'};
export const defaultFollow=()=>({enabled:false,linked:true,loops:1,beats:4,a:'next',b:'none',chance:100,jumpA:1,jumpB:1});
export function validateFollow(f){
 if(f===undefined)return;
 if(!f||Array.isArray(f)||typeof f.enabled!=='boolean'||typeof f.linked!=='boolean'||!Number.isInteger(f.loops)||f.loops<1||f.loops>999||!Number.isFinite(f.beats)||f.beats<.0625||f.beats>16384||!Object.hasOwn(FOLLOW_ACTIONS,f.a)||!Object.hasOwn(FOLLOW_ACTIONS,f.b)||!Number.isFinite(f.chance)||f.chance<0||f.chance>100||!Number.isInteger(f.jumpA)||f.jumpA<1||f.jumpA>32||!Number.isInteger(f.jumpB)||f.jumpB<1||f.jumpB>32)throw new Error('Invalid clip Follow Action settings.');
}
export function followDelay(clip,offset=0){const f=clip.follow;return f?.enabled?Math.max(.0625,f.linked?clip.beats*f.loops-offset:f.beats):null;}
// Return undefined for No action, null for Stop, otherwise a zero-based slot.
export function followTarget(slots,slot,f,random=Math.random){
 const side=random()*100<f.chance?'A':'B',action=f[side.toLowerCase()];
 if(action==='none')return undefined;if(action==='stop')return null;
 if(action==='jump')return slots[f['jump'+side]-1]?f['jump'+side]-1:undefined;
 if(!slots[slot])return undefined;
 let first=slot,last=slot;while(first>0&&slots[first-1])first--;while(last+1<slots.length&&slots[last+1])last++;
 if(action==='again')return slot;if(action==='first')return first;if(action==='last')return last;
 if(action==='next')return slot===last?first:slot+1;if(action==='previous')return slot===first?last:slot-1;
 const choices=Array.from({length:last-first+1},(_,i)=>i+first).filter(i=>action!=='other'||i!==slot);if(!choices.length)return slot;
 return choices[Math.min(choices.length-1,Math.floor(random()*choices.length))];
}
