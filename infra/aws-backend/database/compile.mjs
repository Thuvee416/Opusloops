import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../../../', import.meta.url);
const hash = source => createHash('sha256').update(source).digest('hex');

// Replay the versioned application logic without editing the historical source
// migrations. Native bootstrap supplies the small auth/storage SQL contracts.
export async function compileSchema() {
  const bootstrap = await readFile(new URL('./bootstrap.sql', import.meta.url), 'utf8');
  const directory = new URL('supabase/migrations/', root);
  const filenames = (await readdir(directory)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!filenames.length) throw new Error('No application migrations found');
  const parts = ['BEGIN;', "SELECT pg_advisory_xact_lock(hashtextextended('opusloops-aws-bootstrap', 0));", bootstrap];
  for (const filename of filenames) {
    const source = await readFile(new URL(filename, directory), 'utf8');
    parts.push(`-- Application migration: ${filename}\n${source}`);
    parts.push(`INSERT INTO private.aws_schema_migrations(filename, sha256) VALUES ('${filename}', '${hash(source)}');`);
  }
  parts.push(await readFile(new URL('./native.sql', import.meta.url), 'utf8'));
  parts.push("COMMENT ON TABLE public.projects IS 'Private offline-first project documents owned by immutable Opusloops identities.';", 'COMMIT;');
  return `${parts.join('\n\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('Usage: node infra/aws-backend/database/compile.mjs (SQL to stdout; no database connection)');
    process.exitCode = 2;
  } else {
    process.stdout.on('error', error => {
      if (error.code === 'EPIPE') process.exit(0); // A downstream database rejected the bootstrap.
      else throw error;
    });
    process.stdout.write(await compileSchema());
  }
}
