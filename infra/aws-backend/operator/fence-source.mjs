import { readFile } from 'node:fs/promises';
import { assertAccount,sourceProject,sourceRequest,sourceQuery } from './aws.mjs';

await assertAccount();
const mode=process.argv[2];
if(!['freeze','unfreeze','status'].includes(mode))throw new Error('Use freeze, unfreeze, or status');
if(mode!=='status') {
  const query=mode==='freeze'?await readFile(new URL('../database/freeze-source.sql',import.meta.url),'utf8'):
    "UPDATE private.opusloops_aws_cutover SET frozen=false,changed_at=now() WHERE singleton=true RETURNING frozen";
  await sourceRequest(`/v1/projects/${sourceProject}/database/query`,{method:'POST',body:JSON.stringify({query,read_only:false})});
}
const state=await sourceQuery('SELECT frozen,changed_at FROM private.opusloops_aws_cutover WHERE singleton=true');
console.log(JSON.stringify({sourceProject,writeFence:state[0]}));
