// Undo stores serializable project snapshots; decoded AudioBuffers stay in the engine.
export class History {
  constructor(project,limit=40){this.limit=limit;this.past=[];this.future=[];this.current=structuredClone(project);this.signature=JSON.stringify(project);}
  commit(project,group=null){group=typeof group==='symbol'?group:null;const previousGroup=this.group;const signature=JSON.stringify(project);if(signature===this.signature){if(!group)this.group=null;return false;}this.group=group;if(!group||group!==previousGroup){this.past.push(this.current);if(this.past.length>this.limit)this.past.shift();}this.current=structuredClone(project);this.signature=signature;this.future=[];return true;}
  undo(){this.group=null;if(!this.past.length)return null;this.future.push(this.current);this.current=this.past.pop();this.signature=JSON.stringify(this.current);return structuredClone(this.current);}
  redo(){this.group=null;if(!this.future.length)return null;this.past.push(this.current);this.current=this.future.pop();this.signature=JSON.stringify(this.current);return structuredClone(this.current);}
}
