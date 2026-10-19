// A real click opens the native chooser; no model-supplied paths or hidden uploads.
export function chooseAgentFile(parent,kind,{signal,assertCurrent}){
 const kinds={open:['Project','.opusloop,.looproom,.json,application/json'],import_audio:['Audio','audio/*'],import_midi:['MIDI','.mid,.midi,audio/midi']},spec=kinds[kind];
 if(!spec)throw new Error('Unsupported file choice.');signal.throwIfAborted();assertCurrent();
 return new Promise((resolve,reject)=>{
  const row=document.createElement('p'),note=document.createElement('span'),choose=document.createElement('button'),cancel=document.createElement('button'),input=document.createElement('input');
  row.className='agent-download agent-file-choice';row.setAttribute('role','group');row.setAttribute('aria-label','Choose '+spec[0]+' File');note.textContent='Choose A '+spec[0]+' File. File Contents Stay In This Browser.';
  choose.type=cancel.type='button';choose.textContent='Choose '+spec[0]+' File';cancel.textContent='Cancel File Selection';input.type='file';input.accept=spec[1];input.hidden=true;
  let settled=false;const finish=(error,file)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);row.remove();if(error)reject(error);else resolve(file);};
  const abort=()=>finish(new DOMException('File selection cancelled','AbortError'));
  choose.onclick=()=>{try{signal.throwIfAborted();assertCurrent();input.value='';input.click();}catch(error){finish(error);}};
  input.onchange=()=>{try{assertCurrent();if(!input.files[0])return abort();finish(null,input.files[0]);}catch(error){finish(error);}};
  input.oncancel=abort;cancel.onclick=abort;signal.addEventListener('abort',abort,{once:true});row.append(note,choose,cancel,input);parent.append(row);parent.scrollTop=parent.scrollHeight;choose.focus({preventScroll:true});
 });
}
