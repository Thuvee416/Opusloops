import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { foundation,sourceProject,sourceQuery,awsOptions,migrationCall } from './aws.mjs';
import { TABLES } from '../runtime/migration.mjs';

export async function snapshot() {
  const outputs=await foundation();
  // One read-only SQL statement gives all tables the same MVCC snapshot. No
  // passwords, user documents, object keys, or emails are printed by this tool.
  const entries=TABLES.map(table=>`'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ${table} t)`).join(',');
  const result=await sourceQuery(`SELECT jsonb_build_object('version',1,'sourceProject','${sourceProject}','takenAt',transaction_timestamp(),'tables',jsonb_build_object(${entries})) AS snapshot`);
  const data=result[0]?.snapshot;
  if(data?.sourceProject!==sourceProject)throw new Error('Source snapshot invalid');
  const bytes=Buffer.from(JSON.stringify(data));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const archive=gzipSync(bytes);
  const key=`snapshots/${data.takenAt.replace(/[^0-9TZ]/g,'')}-${sha256}.json.gz`;
  await new S3Client(awsOptions).send(new PutObjectCommand({Bucket:outputs.MigrationBucket,Key:key,Body:archive,ContentType:'application/gzip',IfNoneMatch:'*',
    ChecksumSHA256:createHash('sha256').update(archive).digest('base64'),Metadata:{sha256,'source-project':sourceProject}}));
  return {data,key,sha256,archive};
}

if(process.argv[1]?.endsWith('/snapshot.mjs')) {
  const mode=process.argv[2]||'backup';
  if(!['backup','restore-staging'].includes(mode))throw new Error('Use backup or restore-staging');
  const result=await snapshot();
  console.log(JSON.stringify({backup:result.key,sha256:result.sha256,compressedBytes:result.archive.length,rows:Object.fromEntries(TABLES.map(table=>[table,result.data.tables[table].length]))}));
  if(mode==='restore-staging') {
    const restored=await migrationCall('restore',{snapshotGzip:result.archive.toString('base64'),sha256:result.sha256});
    console.log(JSON.stringify(restored));
    console.log(JSON.stringify(await migrationCall('counts')));
  }
}
