// Copy mutable JSON containers, retaining immutable strings by reference. Native
// structuredClone copies large embedded base64 audio strings on every edit.
function cloneSnapshot(value,seen=new WeakMap()){
 if(value===null||typeof value!=='object')return typeof value==='function'||typeof value==='symbol'?structuredClone(value):value;
 if(seen.has(value))return seen.get(value);
 const prototype=Object.getPrototypeOf(value);
 if(!Array.isArray(value)&&prototype!==Object.prototype&&prototype!==null)return structuredClone(value);
 const copy=Array.isArray(value)?new Array(value.length):{};seen.set(value,copy);
 for(const key of Object.keys(value))Object.defineProperty(copy,key,{value:cloneSnapshot(value[key],seen),enumerable:true,writable:true,configurable:true});
 return copy;
}
// Undo stores independent editable snapshots; decoded AudioBuffers stay in the engine.
export class History {
  constructor(project,limit=40){this.id=crypto.randomUUID();this.revision=0;this.limit=limit;this.past=[];this.future=[];this.current=cloneSnapshot(project);this.signature=JSON.stringify(project);}
  commit(project,group=null){group=typeof group==='symbol'?group:null;const previousGroup=this.group;const signature=JSON.stringify(project);if(signature===this.signature){if(!group)this.group=null;return false;}this.group=group;if(!group||group!==previousGroup){this.past.push(this.current);if(this.past.length>this.limit)this.past.shift();}this.current=cloneSnapshot(project);this.signature=signature;this.future=[];this.revision++;return true;}
  preview(action,steps=1){if(!['undo','redo'].includes(action)||!Number.isInteger(steps)||steps<1)return null;const stack=action==='undo'?this.past:this.future;return stack.length>=steps?cloneSnapshot(stack[stack.length-steps]):null;}
  move(action,steps=1){
    if(!['undo','redo'].includes(action)||!Number.isInteger(steps)||steps<1)return null;
    const source=action==='undo'?this.past:this.future,destination=action==='undo'?this.future:this.past;
    if(source.length<steps)return null;
    this.group=null;
    for(let i=0;i<steps;i++){destination.push(this.current);this.current=source.pop();}
    this.revision+=steps;this.signature=JSON.stringify(this.current);return cloneSnapshot(this.current);
  }
  undo(){return this.move('undo');}
  redo(){return this.move('redo');}
}
