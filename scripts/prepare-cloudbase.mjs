import { readFile, writeFile, mkdir, readdir, lstat, copyFile, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ENV = /^[a-z0-9][a-z0-9_-]{2,79}$/i;
const ACCOUNT = /^wechat:[a-f0-9]{64}$/;
export function cloudbaseInputs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--env', '--admin-account', '--operator-account'].includes(key) || values[key] || !value) throw new Error('Use --env ENV_ID with optional --admin-account and --operator-account. Never pass a secret.');
    values[key] = value;
  }
  if (!ENV.test(values['--env'] || '') || /^(?:your[-_]|replace[-_]|example|env[-_]id)/i.test(values['--env'])) throw new Error('An actual CloudBase environment ID is required.');
  for (const key of ['--admin-account', '--operator-account']) if (values[key] && !ACCOUNT.test(values[key])) throw new Error('Use a verified WeChat account ID, never an OpenID or secret.');
  return { env: values['--env'], admin: values['--admin-account'] || '', operator: values['--operator-account'] || '' };
}

async function safeCopy(source, target, { native = false } = {}) {
  await mkdir(target, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === 'runtime.config.json') continue;
    const from = join(source, item.name), to = join(target, item.name);
    if (item.isDirectory()) { await safeCopy(from, to, { native }); continue; }
    if (!item.isFile() || (await lstat(from)).isSymbolicLink()) throw new Error('Deployment packages cannot contain links or special files.');
    const allowed = native ? /\.(?:js|json|wxml|wxss|jpg|jpeg|png|webp)$/i : /\.(?:js|cjs|json|md)$/i;
    if (!allowed.test(item.name)) continue;
    await copyFile(from, to);
  }
}

export async function prepareCloudbase(root, args) {
  const input = cloudbaseInputs(args);
  const project = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
  if (!/^wx[a-f0-9]{16}$/.test(project.appid || '')) throw new Error('Configure the actual local AppID first.');
  for (const required of ['miniprogram/app.json', 'cloudfunctions/market/index.js', 'cloudfunctions/market/lib/api.js', 'cloudfunctions/market/collections.json']) {
    if (!(await lstat(join(root, required))).isFile()) throw new Error('Build the native client and CloudBase functions before packaging.');
  }
  const parent = join(root, '.wechat-local'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'cloudbase-'));
  await safeCopy(join(root, 'miniprogram'), join(directory, 'miniprogram'), { native: true });
  const functionRoot = join(directory, 'cloudfunctions');
  await safeCopy(join(root, 'cloudfunctions/market'), join(functionRoot, 'longshang-market'));
  const runtime = { WECHAT_APP_ID: project.appid, CLOUDBASE_ENV_ID: input.env };
  if (input.admin) runtime.BOOTSTRAP_ADMIN_ACCOUNT_ID = input.admin;
  await writeFile(join(functionRoot, 'longshang-market/runtime.config.json'), JSON.stringify(runtime, null, 2) + '\n');
  try {
    await lstat(join(root, 'cloudfunctions/provision/index.js'));
    await safeCopy(join(root, 'cloudfunctions/provision'), join(functionRoot, 'longshang-provision'));
    await writeFile(join(functionRoot, 'longshang-provision/runtime.config.json'), JSON.stringify({ WECHAT_APP_ID: project.appid, CLOUDBASE_ENV_ID: input.env, ...(input.operator ? { PROVISION_OPERATOR_ACCOUNT_ID: input.operator } : {}) }, null, 2) + '\n');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(directory, 'miniprogram/config.js'), '// Local deployment configuration; generated outside the tracked source.\nmodule.exports = ' + JSON.stringify({ mode: 'cloud', transport: 'cloudbase', cloudEnv: input.env, cloudFunction: 'longshang-market', requestTimeout: 15000 }, null, 2) + ';\n');
  const example = JSON.parse(await readFile(join(root, 'project.config.example.json'), 'utf8'));
  await writeFile(join(directory, 'project.config.json'), JSON.stringify({ ...example, appid: project.appid, projectname: 'longshang-fresh-cloud', cloudfunctionRoot: 'cloudfunctions/', miniprogramRoot: 'miniprogram/' }, null, 2) + '\n');
  const files = [];
  async function inventory(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name);
      if (item.isDirectory()) await inventory(full);
      else { const data = await readFile(full); files.push({ path: relative(directory, full), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); }
    }
  }
  await inventory(directory);
  const report = { env: input.env, project: directory, functionName: 'longshang-market', nativeMode: 'cloudbase', deployed: false, rulesVerified: false, paidResourcesCreated: false, files };
  await writeFile(join(directory, 'preparation.json'), JSON.stringify(report, null, 2) + '\n');
  return { project: directory, env: input.env, functionName: report.functionName, files: files.length, deployed: false, rulesVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await prepareCloudbase(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
