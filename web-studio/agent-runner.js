import {applyAgentActions} from './agent-actions.js';

const decode = action => typeof action.args === 'string' ? JSON.parse(action.args) : structuredClone(action.args);
const signature = project => JSON.stringify(project);

// Preflight the whole plan before changing either transport or project state.
// All musical edits share one candidate and preserve aliases across actions.
export function prepareAgentPlan(project, actions) {
  if (!Array.isArray(actions) || actions.length > 80) throw new Error('Use at most 80 actions per request.');
  const edits = [], before = [], after = [];
  const hasEdits = actions.some(a => a?.type !== 'command');
  let runtimeStarted = false;
  for (const action of actions) {
    if (action?.type === 'command') {
      const command = decode(action);
      if (hasEdits && !edits.length && !runtimeStarted && ['stop', 'pause'].includes(command?.name)) before.push(command);
      else { runtimeStarted = true; after.push(command); }
    } else {
      if (runtimeStarted) throw new Error('Put project edits before playback, navigation, save or export commands. Stop/pause may precede edits.');
      edits.push(action);
    }
  }
  if (before.length + after.length > 8) throw new Error('Use at most eight runtime commands per request.');
  const next = applyAgentActions(project, edits);
  for (const command of [...before, ...after]) applyAgentActions(next, [{type:'command', args:command}]);
  return {next, editCount:edits.length, before, after};
}

export async function runAgentPlan(plan, {getProject, expected, locked, commit, execute, signal, onStep = () => {}}) {
  let fingerprint = expected, editsApplied = false;
  const completedCommands = [], observations = [];
  let commitStarted = false;
  const check = () => {
    signal.throwIfAborted();
    if (signature(getProject()) !== fingerprint || locked('request')) throw new Error('The session changed while executing. Remaining actions stopped.');
  };
  const run = async command => {
    check();
    const result = await execute(command, signal);
    observations.push({name:command.name, result:result ?? null});
    completedCommands.push(command.name);
    // Runtime operations cannot silently replace/edit the project.
    check();
    onStep({type:'command', name:command.name, result:result ?? null});
  };
  try {
    check();
    for (const command of plan.before) await run(command);
    if (plan.editCount) {
      check();
      if (locked('edit')) throw new Error('Stop playback before editing. Put a stop command before the project edits.');
      const intended = signature(plan.next);
      commitStarted = true;
      commit(plan.next);
      editsApplied = true;
      fingerprint = signature(getProject());
      if (fingerprint !== intended) throw new Error('The applied project does not match the validated plan.');
      onStep({type:'edits', count:plan.editCount});
    }
    for (const command of plan.after) await run(command);
    return {editsApplied, completedCommands, observations};
  } catch (error) {
    // Preserve what actually happened: downloads/transport cannot be undone by
    // restoring a project, and a failed export must not hide committed edits.
    error.agentEditsApplied = editsApplied || (commitStarted && signature(getProject()) !== expected);
    error.agentCompletedCommands = completedCommands;
    throw error;
  }
}
