// Piano-roll edits are distinct from playing the computer MIDI keyboard.
export function noteKeyCommand(event,grid){
 if(event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return null;
 const direction={ArrowLeft:-1,ArrowRight:1,ArrowUp:1,ArrowDown:-1}[event.key];
 if(!Number.isFinite(direction))return null;
 if(![.0625,.125,.25,.5,1].includes(grid))throw Error('Choose A Valid Note Grid.');
 const horizontal=event.key==='ArrowLeft'||event.key==='ArrowRight';
 return horizontal
  ?{action:event.shiftKey?'resize':'move',options:{deltaBeats:direction*grid,grid}}
  :{action:'move',options:{deltaPitch:direction*(event.shiftKey?12:1),grid}};
}
