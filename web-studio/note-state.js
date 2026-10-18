// Legacy notes without an activation field remain playable.
export const isNoteActive=note=>note.active!==false;
export const validNoteActivation=note=>note.active===undefined||typeof note.active==='boolean';

export const validReleaseVelocity=note=>note.releaseVelocity===undefined||(Number.isFinite(note.releaseVelocity)&&note.releaseVelocity>=0&&note.releaseVelocity<=1);

export function midiPitchName(pitch){return ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][pitch%12]+(Math.floor(pitch/12)-1);}
