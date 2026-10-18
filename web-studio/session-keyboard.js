// Visible tracks are supplied by the same group-folding model used to render.
export function sessionNeighbor(trackIds,scenes,current,key){
 if(!trackIds.length||!Number.isInteger(scenes)||scenes<1)return null;
 let column=current?.kind==='scene'?trackIds.length:trackIds.indexOf(current?.trackId),scene=current?.scene;
 if(column<0||!Number.isInteger(scene)||scene<0||scene>=scenes)return null;
 if(key==='ArrowLeft')column=Math.max(0,column-1);
 else if(key==='ArrowRight')column=Math.min(trackIds.length,column+1);
 else if(key==='ArrowUp')scene=Math.max(0,scene-1);
 else if(key==='ArrowDown')scene=Math.min(scenes-1,scene+1);
 else return null;
 return column===trackIds.length?{kind:'scene',scene}:{kind:'slot',trackId:trackIds[column],scene};
}
