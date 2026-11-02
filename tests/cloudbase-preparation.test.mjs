import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloudbaseInputs, prepareCloudbase } from '../scripts/prepare-cloudbase.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'longshang-cloudbase-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['miniprogram', 'cloudfunctions/market/lib', 'cloudfunctions/market/node_modules', 'cloudfunctions/provision']) await mkdir(join(root, path), { recursive: true });
  const files = {
    'project.config.json': JSON.stringify({ appid: 'wx0123456789abcdef' }),
    'project.config.example.json': JSON.stringify({ setting: { urlCheck: true }, appid: 'touristappid' }),
    'miniprogram/app.json': '{"pages":[]}', 'miniprogram/config.js': "module.exports={mode:'mock'};",
    'cloudfunctions/market/index.js': 'exports.main=()=>{};', 'cloudfunctions/market/lib/api.js': 'exports.api=()=>{};',
    'cloudfunctions/market/collections.json': '[]', 'cloudfunctions/market/package.json': '{"main":"index.js"}',
    'cloudfunctions/market/runtime.config.json': '{"doNotCopy":"private-existing-config"}',
    'cloudfunctions/market/.env': 'do-not-copy', 'cloudfunctions/market/private.key': 'do-not-copy',
    'cloudfunctions/market/node_modules/example.js': 'do-not-copy', 'cloudfunctions/provision/index.js': 'exports.main=()=>{};'
  };
  for (const [path, data] of Object.entries(files)) await writeFile(join(root, path), data);
  return root;
}

test('CloudBase preparation rejects secrets, placeholder environments and malformed account IDs', () => {
  for (const args of [[], ['--env', '../other'], ['--env', 'example'], ['--env', 'env-id'], ['--secret', 'x'], ['--env', 'cloud1-test', '--env', 'cloud2-test'], ['--env', 'cloud1-test', '--admin-account', 'openid-value']]) assert.throws(() => cloudbaseInputs(args));
});
test('CloudBase packaging isolates identity/configuration without modifying the mock checkout or copying credentials', async t => {
  const root = await fixture(t), id = 'wechat:' + 'a'.repeat(64);
  const result = await prepareCloudbase(root, ['--env', 'cloud1-test', '--operator-account', id]);
  assert.equal(result.deployed, false); assert.equal(result.rulesVerified, false);
  assert.match(await readFile(join(root, 'miniprogram/config.js'), 'utf8'), /mock/);
  assert.match(await readFile(join(result.project, 'miniprogram/config.js'), 'utf8'), /cloud1-test/);
  const runtime = JSON.parse(await readFile(join(result.project, 'cloudfunctions/longshang-market/runtime.config.json'), 'utf8'));
  assert.deepEqual(runtime, { WECHAT_APP_ID: 'wx0123456789abcdef', CLOUDBASE_ENV_ID: 'cloud1-test' });
  const operator = JSON.parse(await readFile(join(result.project, 'cloudfunctions/longshang-provision/runtime.config.json'), 'utf8'));
  assert.equal(operator.PROVISION_OPERATOR_ACCOUNT_ID, id);
  const deployedFiles = await readdir(join(result.project, 'cloudfunctions/longshang-market'));
  for (const excluded of ['node_modules', '.env', 'private.key']) assert.equal(deployedFiles.includes(excluded), false);
  const next = await prepareCloudbase(root, ['--env', 'cloud1-test']); assert.notEqual(result.project, next.project);
});
test('CloudBase package rejects symlinks before deployment', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'cloudfunctions/market/.env'), join(root, 'miniprogram/leak.js'));
  await assert.rejects(prepareCloudbase(root, ['--env', 'cloud1-test']), /links/);
});
