export function crossfadeGain(assignment='none',position=0,curve='blend'){
 if(assignment==='none')return 1;const x=assignment==='A'?position:-position;if(x<=-1)return 1;if(x>=1)return 0;
 return curve==='equalPower'?Math.cos((x+1)*Math.PI/4):Math.min(1,1-x);
}
export function validateCrossfade(project){const setting=project.crossfade;if(setting!==undefined&&(!setting||!Number.isFinite(setting.position)||setting.position<-1||setting.position>1||!['blend','equalPower'].includes(setting.curve)))throw new Error('Invalid crossfader settings.');for(const track of [...project.tracks,...(project.returns||[])])if(track.crossfade!==undefined&&!['none','A','B'].includes(track.crossfade))throw new Error('Invalid crossfade assignment.');}
