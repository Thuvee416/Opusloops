export const WARP_MARKER_LIMIT=64;
export function validateWarpMarkers(markers){
 if(markers===undefined)return;
 if(!Array.isArray(markers)||markers.length>WARP_MARKER_LIMIT)throw new Error('Use at most 64 Warp markers.');
 let source=0,target=0;
 for(const m of [...markers,{source:1,target:1}]){
  if(!m||!Number.isFinite(m.source)||!Number.isFinite(m.target)||m.source>1||m.target>1||m.source-source<.0001-1e-10||m.target-target<.0001-1e-10)throw new Error('Warp markers must stay in source and target order, inside the clip endpoints.');
  source=m.source;target=m.target;
 }
}
export function warpSegments(markers=[],rate=1){
 validateWarpMarkers(markers);const points=[{source:0,target:0},...markers,{source:1,target:1}];
 return points.slice(0,-1).map((p,i)=>{const next=points[i+1],speed=rate*(next.source-p.source)/(next.target-p.target);if(!Number.isFinite(speed)||speed<1/32||speed>32)throw new Error('Warp segments must stay between 1/32× and 32× speed. Move the markers farther apart.');return {...p,rate:speed};});
}
export function insertWarpMarker(markers=[],target){
 validateWarpMarkers(markers);const points=[{source:0,target:0},...markers,{source:1,target:1}],i=points.findIndex(p=>p.target>target);
 if(i<1)throw new Error('Add a Warp marker inside the clip.');const left=points[i-1],right=points[i],source=left.source+(right.source-left.source)*(target-left.target)/(right.target-left.target),next=markers.map(p=>({...p}));next.splice(i-1,0,{source,target});validateWarpMarkers(next);return next;
}
