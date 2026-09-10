import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { S3Client,PutObjectCommand } from '@aws-sdk/client-s3';
import { foundation,sourceQuery,migrationCall,awsOptions } from './aws.mjs';
import { snapshot } from './snapshot.mjs';
import { importIdentities } from './import-identities.mjs';

const outputs=await foundation();
const state=await sourceQuery('SELECT frozen FROM private.opusloops_aws_cutover WHERE singleton=true');
if(state[0]?.frozen!==true)throw new Error('Final copy requires a verified source write fence');
const {data,archive,key,sha256}=await snapshot();
if(data.tables['auth.users'].some(row=>row.raw_app_meta_data?.migration_canary))throw new Error('Source unexpectedly contains migration test accounts');
await migrationCall('restore',{snapshotGzip:archive.toString('base64'),sha256});
const verified=await migrationCall('verify',{snapshotGzip:archive.toString('base64'),sha256});
console.log(JSON.stringify({finalDatabaseCopy:'verified',backupKey:key,tables:verified.tables}));
const {stdout}=await promisify(execFile)(process.execPath,[new URL('copy-storage.mjs',import.meta.url).pathname],{maxBuffer:4*1024*1024});
const storage=JSON.parse(stdout.trim().split('\n').at(-1));
if(storage.complete!==true||storage.verified!==data.tables['storage.objects'].length)throw new Error('Final storage verification failed');
console.log(JSON.stringify({finalStorageCopy:storage}));
const identities=await importIdentities(data.tables['auth.users']);
const report={version:1,verifiedAt:new Date().toISOString(),backupKey:key,sha256,tables:verified.tables,storage,identities:{imported:identities.imported,jobId:identities.jobId}};
const reportBytes=Buffer.from(JSON.stringify(report));
const reportHash=createHash('sha256').update(reportBytes).digest('hex');
await new S3Client(awsOptions).send(new PutObjectCommand({Bucket:outputs.MigrationBucket,Key:`verification/final-${reportHash}.json`,Body:reportBytes,ContentType:'application/json',IfNoneMatch:'*'}));
console.log(JSON.stringify({finalCopy:'verified',importedUsers:identities.imported,reportKey:`verification/final-${reportHash}.json`}));
// Deliberately do not activate here. Review the verification report and release
// the tested client before removing the temporary operator helper.
