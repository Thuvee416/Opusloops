import {validateProject} from './model.js';
const signature=p=>JSON.stringify(p);
export function historyState(history){return {id:history.id,revision:history.revision,undoCount:history.past.length,redoCount:history.future.length};}
export function assertHistoryState(expected,actual){if(expected&&signature(expected)!==signature(actual))throw new Error('The Undo history changed while planning or executing. Nothing further was applied; ask again for the current edit.');}
export function historyIntent(args){
 if(!args||!['undo','redo'].includes(args.action)||Object.keys(args).some(k=>!['action','steps'].includes(k))||!Number.isInteger(args.steps??1)||(args.steps??1)<1||(args.steps??1)>40)throw new Error('history requires action undo/redo and optional steps from 1 to 40.');
 return {action:args.action,steps:args.steps??1};
}
// Model command aliases enter the same strict contract as the canonical form.
export function normalizeHistoryCommand(command){
 if(!command||!['undo','redo'].includes(command.name))return command;
 const args=command.args??{};
 if(typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='steps')||Object.keys(command).some(k=>!['name','args'].includes(k)))throw new Error('Undo/Redo commands accept only optional steps; use history with action undo/redo.');
 return {name:'history',args:historyIntent({action:command.name,...args})};
}
export function prepareHistory(project,args,state,preview){
 const intent=historyIntent(args),count=state?.[intent.action==='undo'?'undoCount':'redoCount'];
 if(!state?.id||!Number.isInteger(state.revision)||typeof preview!=='function')throw new Error('Refresh the Studio history before requesting Undo or Redo.');
 if(count<intent.steps)throw new Error(count?`Only ${count} ${intent.action==='undo'?'Undo':'Redo'} steps are available. Nothing changed.`:`Nothing to ${intent.action==='undo'?'Undo':'Redo'}.`);
 const target=preview(intent.action,intent.steps);if(!target)throw new Error('The requested history snapshot is unavailable.');validateProject(target);
 return {intent,binding:{...state},target:structuredClone(target)};
}
export function checkHistoryReceipt(prepared,after,result,state){
 const {intent,binding,target}=prepared,undo=intent.action==='undo';
 if(!result?.history||result.action!==intent.action||result.steps!==intent.steps||signature(after)!==signature(target)||state.id!==binding.id||state.revision!==binding.revision+intent.steps||state.undoCount!==binding.undoCount+(undo?-intent.steps:intent.steps)||state.redoCount!==binding.redoCount+(undo?intent.steps:-intent.steps))throw new Error('The history result does not match the validated snapshot. Inspect the project before continuing.');
 return true;
}
const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
export function readHistoryRequest(prompt,{compound=false}={}){
 const text=String(prompt).trim().replace(/[.!?]+$/,'');
 const match=/^(?:please\s+)?(undo|redo)(?:\s+(?:the\s+)?(?:last\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:changes?|edits?|steps?|actions?)|\s+(?:that|this))?(?:\s+please)?(?=$|\s+(?:and|then)\b)/i.exec(text);
 if(!match||!compound&&match[0].length!==text.length)return null;
 const steps=match[2]?(words[match[2].toLowerCase()]??Number(match[2])):1;
 return {action:match[1].toLowerCase(),steps};
}
export function directHistoryPlan(prompt){const intent=readHistoryRequest(prompt);return intent?{summary:'History Control',actions:[{type:'command',args:{name:'history',args:intent}}]}:null;}
export function describeHistory(result){return `${result.action==='undo'?'Undid':'Redid'} ${result.steps} ${result.steps===1?'Edit':'Edits'}. ${result.undoCount} Undo And ${result.redoCount} Redo Steps Available.`;}
