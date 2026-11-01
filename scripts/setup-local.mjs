import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}/.openai`, { recursive: true });
try { await copyFile(`${root}/hosting.example.json`, `${root}/.openai/hosting.json`, constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
try { await writeFile(`${root}/.dev.vars`, 'BOOTSTRAP_ADMIN_EMAIL="seedy@sites.test"\n', { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
console.log('Local configuration ready; existing hosting and private settings were preserved.');
console.log('Cloud preview: npm run build, npm run db:local, then npm run dev.');
