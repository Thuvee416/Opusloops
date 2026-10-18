// Presentation uses the audible clock, not the scheduler's look-ahead position.
export function clipFeedback({playing,mode,override=false,active,pending,clipId,slot,beats,beat}){
 const owns=playing&&(mode==='session'||override),same=owns&&active?.clipId===clipId&&(active.slot===undefined||active.slot===slot);
 const waiting=owns&&pending&&(pending.slot===undefined||pending.slot===slot)&&(pending.clipId===clipId||same&&(pending.toggleSource===clipId||pending.gateSource===clipId));
 const scheduled=!!same&&active.start>beat+1e-7,started=!!same&&!scheduled;
 const phase=started&&beats>0?((beat-active.start)%beats+beats)%beats/beats:0;
 return {playing:started,queued:!!waiting||scheduled,stopping:!!waiting&&pending.clipId===null,phase,pulse:Math.floor(Math.max(0,beat)*2)%2===0};
}
