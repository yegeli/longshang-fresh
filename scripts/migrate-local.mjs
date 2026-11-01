import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(`${root}/dist/server/wrangler.json`, 'utf8'));
if (!config.d1_databases?.some(db => db.binding === 'DB')) throw new Error('Build with the DB binding before running local migrations.');
// Wrangler tracks applied migration names in local D1; never replay applied SQL.
config.d1_databases = config.d1_databases.map(db => ({ ...db, migrations_dir: `${root}/drizzle` }));
delete config.main; delete config.assets;
await mkdir(`${root}/.sites-runtime`, { recursive: true });
const configPath = `${root}/.sites-runtime/migrations.json`;
await writeFile(configPath, JSON.stringify(config));
const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', configPath, '--persist-to', '.wrangler/state'], { cwd: root, input: 'y\n', stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
