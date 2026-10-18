// A bounded default-preservation contract for explicit fresh MIDI creation.
// Follow-ups that refer to earlier settings remain model planned, not inferred
// by this check. This is not a general musical-intent validator.
export function readCreationLaunchRequirement(prompt){
 const text=String(prompt??'');
 if(!/\b(?:create|add|needs?)\b[\s\S]{0,700}\bMIDI\s+clips?\b/i.test(text)||!/\bno other (?:edits|changes)\b/i.test(text)||/\b(?:launch|legato|same|reuse|previous|earlier|before|again|repeat)\b/i.test(text))return null;
 return {kind:'fresh-midi-default-launch'};
}
export function checkCreationLaunchRequirement(actions,requirement){
 if(!requirement)return null;
 if(requirement.kind!=='fresh-midi-default-launch')throw new Error('Unsupported MIDI Creation Requirement.');
 for(const action of actions){const args=typeof action.args==='string'?JSON.parse(action.args):action.args;
  if((action.type==='midi'&&args.launch!==undefined)||(['clip','clip_properties'].includes(action.type)&&args.changes?.launch!==undefined))throw new Error('This Request Creates Fresh MIDI Clips With Default Launch Settings And Says No Other Edits. Omit All Launch And Legato Changes; Do Not Carry Settings From Earlier Conversation. Return A Complete Replacement Plan.');
 }
 return {kind:requirement.kind};
}
