// One monochrome vector set for transport, editing and workspace navigation.
const shapes={
 play:'<path d="m5 3 8 5-8 5Z" fill="currentColor" stroke="none"/>',
 pause:'<path d="M5 3v10M11 3v10" stroke-width="3"/>',
 stop:'<rect x="4" y="4" width="8" height="8" rx=".5" fill="currentColor" stroke="none"/>',
 record:'<circle cx="8" cy="8" r="4" fill="currentColor" stroke="none"/>',
 circle:'<circle cx="8" cy="8" r="4"/>',
 plus:'<path d="M8 3v10M3 8h10"/>',
 close:'<path d="m4 4 8 8M12 4l-8 8"/>',
 left:'<path d="M13 8H3m4-4L3 8l4 4"/>',
 right:'<path d="M3 8h10M9 4l4 4-4 4"/>',
 up:'<path d="M8 13V3M4 7l4-4 4 4"/>',
 down:'<path d="M8 3v10m-4-4 4 4 4-4"/>',
 'chevron-left':'<path d="m10 3-5 5 5 5"/>',
 'chevron-right':'<path d="m6 3 5 5-5 5"/>',
 'chevron-down':'<path d="m3 6 5 5 5-5"/>',
 undo:'<path d="M6 3 2 7l4 4M2 7h7a4 4 0 0 1 4 4v2"/>',
 redo:'<path d="m10 3 4 4-4 4m4-4H7a4 4 0 0 0-4 4v2"/>',
 external:'<path d="M9 3h4v4m0-4L6 10M6 3H3v10h10v-3"/>',
 loop:'<path d="m3 3-2 2 2 2m-2-2h10a3 3 0 0 1 3 3m-1 5 2-2-2-2m2 2H5a3 3 0 0 1-3-3"/>',
 browser:'<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12"/>',
 session:'<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M6 2v12M10 2v12M2 6h12M2 10h12"/>',
 arrangement:'<path d="M2 4h12M2 8h12M2 12h12M6 2v4M10 6v4M5 10v4"/>',
 metronome:'<path d="m6 2-4 12h10L8 2Zm1 7 5-6M6 11h3"/>',
 flag:'<path d="M4 14V2h8l-2 3 2 3H4"/>',
 more:'<circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1" fill="currentColor" stroke="none"/>',
 settings:'<path d="M3 2v12M8 2v12M13 2v12"/><path d="M1 5h4M6 10h4M11 6h4" stroke-width="3"/>'
};
export function icon(name){
 if(!Object.hasOwn(shapes,name))throw new Error('Unknown studio icon: '+name);
 return `<svg class="studio-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><use href="#opus-icon-${name}"/></svg>`;
}
export function installIcons(){
 if(document.getElementById('opus-icon-definitions'))return;
 const template=document.createElement('template');
 template.innerHTML=`<svg id="opus-icon-definitions" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs>${Object.entries(shapes).map(([name,shape])=>`<symbol id="opus-icon-${name}" viewBox="0 0 16 16">${shape}</symbol>`).join('')}</defs></svg>`;
 document.body.prepend(template.content);
}
