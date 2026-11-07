import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {compileFunction} from 'node:vm';
const require = createRequire(import.meta.url);
const {createProvision} = require('../cloudfunctions/provision/lib/provision');
const {digest} = require('../cloudfunctions/provision/lib/contract');
const APPID = 'wx1111111111111111', ENV_ID = 'cloud1-entry-test';
const account = openid => 'wechat:' + digest(APPID + '\0' + openid);
const source = readFileSync(new URL('../cloudfunctions/provision/index.js', import.meta.url), 'utf8');
function entry({openid = 'buyer', operator = false} = {}) {
  const context = {APPID, OPENID: openid, ENV: ENV_ID};
  const config = {WECHAT_APP_ID: APPID, CLOUDBASE_ENV_ID: ENV_ID, ...(operator ? {PROVISION_OPERATOR_ACCOUNT_ID: account('operator')} : {})};
  const cloud = {DYNAMIC_CURRENT_ENV: Symbol('current-env'), init() {}, getWXContext: () => context, database() {assert.fail('Denied and identity entry calls must not access database');}};
  const exports = {};
  compileFunction(source, ['require', 'exports'], {filename: 'cloudfunctions/provision/index.js'})(name => {
    if (name === 'wx-server-sdk') return cloud;
    if (name === './lib/config') return {runtimeConfig: () => config};
    if (name === './lib/provision') return {createProvision};
    assert.fail('Denied and identity entry calls must not initialize manager: ' + name);
  }, exports);
  return {main: exports.main, context};
}
test('real provision entry accepts platform metadata while deriving identity only from trusted SDK context', async () => {
  const f = entry();
  assert.deepEqual(await f.main({operation: 'identity', userInfo: {openId: 'platform-user', appId: APPID}}), {status: 200, body: {accountId: account('buyer')}});
  assert.deepEqual(await f.main({operation: 'identity', tcbContext: {openid: 'platform-user', appid: APPID}}), {status: 200, body: {accountId: account('buyer')}});
  assert.deepEqual(await f.main({operation: 'identity', userInfo: {openId: 'platform-user'}, tcbContext: {openid: 'platform-user'}}), {status: 200, body: {accountId: account('buyer')}});
  assert.deepEqual(await f.main({operation: 'identity'}), {status: 200, body: {accountId: account('buyer')}});
});
test('forged userInfo and tcbContext cannot select the account, environment or operator role at the provision entry', async () => {
  const f = entry({operator: true});
  const userInfo = {openId: 'operator', appId: APPID, env: ENV_ID, role: 'admin', accountId: account('operator')};
  const tcbContext = {openid: 'operator', appid: APPID, env: ENV_ID, role: 'admin', operatorAccountId: account('operator')};
  for (const metadata of [{userInfo}, {tcbContext}, {userInfo, tcbContext}]) {
    assert.equal((await f.main({operation: 'identity', ...metadata})).body.accountId, account('buyer'));
    assert.equal((await f.main({operation: 'runtime-configure', apply: true, ...metadata})).body.error.code, 'operator_forbidden');
  }
  f.context.APPID = 'wx2222222222222222';
  assert.equal((await f.main({operation: 'identity', userInfo, tcbContext})).body.error.code, 'wechat_context_invalid');
  f.context.APPID = APPID;f.context.ENV = 'other-env';
  assert.equal((await f.main({operation: 'identity', userInfo, tcbContext})).body.error.code, 'environment_mismatch');
});
test('provision entry strips only userInfo/tcbContext and retains rejection of other unknown or malformed input', async () => {
  const f = entry();
  for (const extra of [{openid: 'operator'}, {accountId: account('operator')}, {role: 'admin'}, {collection: 'lsf_meta'}, {timeout: 30}])
    assert.equal((await f.main({operation: 'identity', userInfo: {}, tcbContext: {}, ...extra})).body.error.code, 'invalid_request');
  for (const event of [null, [], Object.assign(Object.create({foreign: true}), {operation: 'identity', userInfo: {}})])
    assert.equal((await f.main(event)).body.error.code, 'invalid_request');
  const original = {operation: 'identity', userInfo: {openId: 'operator'}, tcbContext: {openid: 'operator'}};
  await f.main(original);
  assert.deepEqual(original, {operation: 'identity', userInfo: {openId: 'operator'}, tcbContext: {openid: 'operator'}});
});
