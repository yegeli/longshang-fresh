import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Node.js 22 or newer is required.');
  process.exit(1);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const groups = await Promise.all(['public', 'scripts', 'tests', 'server', 'miniprogram', 'wechat-worker', 'cloudfunctions'].map(directory => sourceFiles(resolve(root, directory))));
const files = groups.flat();
for (const file of files) run(['--check', file]);
console.log(`Syntax checked ${files.length} source/test files.`);
const tests = groups[2].filter(file => /\.test\.(?:js|mjs|cjs)$/.test(file));
if (tests.length === 0) throw new Error('No tests found.');
run(['--test', ...tests.map(file => relative(root, file))]);
