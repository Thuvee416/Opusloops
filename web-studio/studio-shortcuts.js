export const TAB_NAVIGATION_KEY='opus-tab-moves-focus';
export function tabMovesFocus(storage){try{return storage.getItem(TAB_NAVIGATION_KEY)==='true';}catch{return false;}}
// Resolve only application-wide commands; local editors own their consumed keys.
export function studioShortcut(e,{typing=false,dialog=false,menu=false,agent=false,tabNavigation=false}={}){
 if(e.defaultPrevented||e.repeat||typing||dialog||menu||agent||e.isComposing)return null;
 const mod=e.metaKey||e.ctrlKey;
 if(mod&&!e.altKey&&e.code==='KeyS')return e.shiftKey?'save-as':'save';
 if(mod&&!e.altKey&&e.code==='KeyZ')return e.shiftKey?'redo':'undo';
 if(e.altKey&&!mod&&!e.shiftKey&&['Digit1','Digit2'].includes(e.code))return e.code==='Digit1'?'session':'arrangement';
 if(mod||e.altKey)return null;
 if(e.code==='Tab'&&!e.shiftKey&&!tabNavigation)return 'toggle_view';
 if(e.shiftKey)return e.code==='Space'?'continue_play':null;
 return {Space:'toggle_play',F9:'record',F10:'back',Home:'return_start'}[e.code]??null;
}
