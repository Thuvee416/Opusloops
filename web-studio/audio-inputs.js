export function audioInputChoices(devices,selected=''){
  const choices=[{id:'',label:'System default',missing:false}],seen=new Set(['','default']);
  for(const d of devices){if(d.kind!=='audioinput'||typeof d.deviceId!=='string'||seen.has(d.deviceId))continue;seen.add(d.deviceId);choices.push({id:d.deviceId,label:d.label||'Audio input '+choices.length,missing:false});}
  if(selected&&!seen.has(selected))choices.push({id:selected,label:'Selected input unavailable',missing:true});
  return choices;
}
