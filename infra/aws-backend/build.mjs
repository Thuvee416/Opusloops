import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { compileSchema } from './database/compile.mjs';

await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
const entries = process.argv.slice(2);
if (!entries.length || entries.some(name => !['database', 'migration', 'api'].includes(name))) throw new Error('Specify database, migration, and/or api');
for (const name of entries) {
  await build({ entryPoints: [new URL(`./runtime/${name}.mjs`, import.meta.url).pathname],
    outfile: new URL(`./dist/${name}.mjs`, import.meta.url).pathname,
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
}
await writeFile(new URL('./dist/schema.sql', import.meta.url), await compileSchema());
const cert = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');
if (!cert.ok) throw new Error('RDS certificate bundle unavailable');
const certificate = await cert.text();
if (!certificate.startsWith('-----BEGIN CERTIFICATE-----')) throw new Error('RDS certificate bundle invalid');
await writeFile(new URL('./dist/rds-ca.pem', import.meta.url), certificate);
console.log(`Built ${entries.join(', ')} with native PostgreSQL schema and RDS trust bundle`);
