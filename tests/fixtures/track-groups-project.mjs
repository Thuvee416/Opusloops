import {routingProject} from './track-routing-project.mjs';
import {editTrackGroup} from '../../web-studio/track-groups.js';
export function groupProject(grouped=false){const p=routingProject(false);p.name='Group proof';if(!grouped)return p;const next=editTrackGroup(p,{action:'create',ids:['a','b'],name:'Drums'}).project,old=next.tracks[0].id;next.tracks[0].id='drums';for(const t of next.tracks){if(t.parentId===old)t.parentId='drums';if(t.output==='track:'+old)t.output='track:drums';}return next;}
