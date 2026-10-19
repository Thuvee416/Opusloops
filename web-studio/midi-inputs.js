// Retain the selected device through hot-plug changes. A missing selection is
// visible rather than silently replaced by the first available keyboard.
export function midiInputChoices(inputs,selectedId='',selectedName='MIDI Input'){
 const connected=[...inputs.values()].filter(port=>port.state==='connected');
 const port=selectedId?connected.find(port=>port.id===selectedId):connected[0];
 const options=connected.map(port=>({id:port.id,label:port.name||'MIDI Input',missing:false}));
 if(selectedId&&!port)options.unshift({id:selectedId,label:`${selectedName||'MIDI Input'} (Disconnected)`,missing:true});
 if(!options.length)options.push({id:'',label:'No MIDI Input Available',missing:true});
 return {options,selectedId:selectedId||port?.id||'',port:port??null};
}
