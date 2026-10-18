import {recordProject} from './record-quantization-project.mjs';
export const performedNotes=[
 {pitch:60,start:.2,duration:.016,velocity:.4,releaseVelocity:.1},
 {pitch:60,start:.224,duration:.01,velocity:.7,releaseVelocity:.3},
 {pitch:67,start:.4,duration:.03,velocity:.6,releaseVelocity:.4},
 {pitch:64,start:.4,duration:.084,velocity:.5,releaseVelocity:.2}
];
export function timingProject(){const p=recordProject();p.name='Input Timing Proof';const c={id:'rapid-take',name:'Rapid Take',kind:'midi',sourceBpm:120,beats:4,notes:structuredClone(performedNotes)};p.clips[c.id]=c;p.tracks[0].slots[0]=c.id;return p;}
export const timingPrompt='Transpose only the C4 notes in Rapid Take up one octave. Preserve every note start, duration, velocity and release velocity exactly, including the very short recorded notes. Leave all other notes and project fields unchanged. Do not play, record, export or change views.';
