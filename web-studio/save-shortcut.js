// A keyboard save must cross the same change boundary as clicking Save.
// Keep Odesa drafts and modal forms separate from project-field commits.
const rejectedFields=new WeakMap();
const fieldValue=field=>JSON.stringify([field.value,field.checked]);
export async function saveFromShortcut(command,{document,getErrorRevision=()=>0,setStatus}){
 const control=document.getElementById(command),save=document.getElementById('save');
 const locked=()=>!control||control.disabled||save?.disabled;
 const unavailable=()=>{setStatus('Finish Recording Or The Current Operation Before Saving.',true);return false;};
 if(locked())return unavailable();
 const field=document.activeElement?.closest('input,textarea,select');
 if(field&&!field.closest('#studio-agent')){
  const value=fieldValue(field);
  if(rejectedFields.get(field)===value){setStatus('Correct The Current Field Before Saving.',true);return false;}
  rejectedFields.delete(field);
  if(!field.checkValidity()){field.reportValidity();setStatus('Correct The Highlighted Field Before Saving.',true);return false;}
  const id=field.id,start=field.selectionStart,end=field.selectionEnd,direction=field.selectionDirection,errorRevision=getErrorRevision();
  field.blur();
  // Existing change handlers can settle validation/re-rendering in a microtask.
  await Promise.resolve();
  const current=id?document.getElementById(id):field;
  if(current?.isConnected&&!current.disabled){
   current.focus({preventScroll:true});
   if(typeof start==='number'&&typeof end==='number'&&typeof current.selectionStart==='number')current.setSelectionRange(start,end,direction);
  }
  if(getErrorRevision()!==errorRevision){if(field.isConnected&&fieldValue(field)===value)rejectedFields.set(field,value);return false;}
 }
 if(locked())return unavailable();
 control.click();return true;
}
