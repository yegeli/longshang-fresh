import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { normalizeCatalogProduct, BASE_CATALOG } from '../public/model.js';
import { bootstrapWechatAdminSQL, parseBootstrapArgs, validateBootstrapConfig } from '../scripts/bootstrap-wechat-admin.mjs';

const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const APP = 'wx0123456789abcdef', OTHER_APP = 'wx1111111111111111', ORIGIN = 'https://wechat-operators.example.test';
class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute(mode) {
    if (this.db.failSQL?.(this.sql)) throw new Error('test-only SQL failure');
    const statement = this.db.sqlite.prepare(this.sql);
    if (mode === 'first') return statement.get(...this.values) || null;
    if (mode === 'all') return { results: statement.all(...this.values) };
    return { meta: { changes: Number(statement.run(...this.values).changes) } };
  }
  async first() { return this.execute('first'); }
  async all() { return this.execute('all'); }
  async run() { return this.execute('run'); }
}
class D1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); for (const sql of migrations) this.sqlite.exec(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.beforeBatch?.(); this.beforeBatch = null;
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
async function data(response, expected = 200) {
  assert.equal(response.status, expected, await response.clone().text());
  return response.json();
}
function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const env = { DB, AUTH_MODE: 'wechat', WECHAT_APP_ID: APP, WECHAT_APP_SECRET: 'test-server-only-secret' };
  const provider = async url => new Response(JSON.stringify({ openid: 'subject-' + new URL(url).searchParams.get('js_code'), session_key: 'test-provider-key' }));
  const call = (path, { method = 'GET', body, token, origin, mode } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    return handleApi(new Request(ORIGIN + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      mode === 'sites' ? { ...env, AUTH_MODE: undefined } : env, { wechatProviderFetch: provider });
  };
  const login = async name => data(await call('/auth/wechat/login', { method: 'POST', body: { code: name } }));
  const bootstrap = id => DB.sqlite.exec(bootstrapWechatAdminSQL({ appId: APP, userId: id }));
  const admin = async () => { const user = await login('operator'); bootstrap(user.session.user.id); return user; };
  const input = (user, extra = {}) => ({ userId: user.session.user.id, name: '模拟景泰采购者', region: '甘肃景泰', status: 'enabled', permissions: ['products', 'orders', 'aftersales'], ...extra });
  const add = async (operator, user, extra = {}) => (await data(await call('/admin/wechat/merchants', { method: 'POST', token: operator.token, body: input(user, extra) }), 201)).merchant;
  const editInput = (profile, extra = {}) => ({ userId: profile.userId, name: profile.name, region: profile.region, status: profile.status,
    permissions: profile.permissions, expectedVersion: profile.version, ...extra });
  return { DB, env, call, login, admin, bootstrap, input, add, editInput };
}

test('bootstrap requires an existing verified account in the selected app; first visitor and arbitrary subjects remain buyers', async t => {
  const f = fixture(t), buyer = await f.login('first');
  assert.equal(buyer.session.role, 'buyer');
  f.bootstrap('wechat:' + '0'.repeat(64));
  f.DB.sqlite.exec(bootstrapWechatAdminSQL({ appId: OTHER_APP, userId: buyer.session.user.id }));
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM admin_bootstrap').get().n, 0);
  assert.equal((await data(await f.call('/session', { token: buyer.token }))).role, 'buyer');
  await data(await f.call('/admin/wechat/bootstrap', { method: 'POST', token: buyer.token, body: {} }), 404);
  f.bootstrap(buyer.session.user.id);
  assert.equal((await data(await f.call('/session', { token: buyer.token }))).role, 'admin');
  f.bootstrap(buyer.session.user.id);
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n, 1);
  const other = await f.login('second'); f.bootstrap(other.session.user.id);
  assert.equal((await data(await f.call('/session', { token: other.token }))).role, 'buyer');
});

test('durable bootstrap claim has one winner and retries repair an interrupted claim only for that exact account', async t => {
  const f = fixture(t), a = await f.login('a'), b = await f.login('b');
  const claim = bootstrapWechatAdminSQL({ appId: APP, userId: a.session.user.id }).split(';')[0] + ';';
  f.DB.sqlite.exec(claim);
  f.bootstrap(b.session.user.id);
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n, 0);
  f.bootstrap(a.session.user.id);
  assert.equal((await data(await f.call('/session', { token: a.token }))).role, 'admin');
  assert.equal((await data(await f.call('/session', { token: b.token }))).role, 'buyer');
});

test('bootstrap never replaces an existing administrator or grants administration to a merchant', async t => {
  const f = fixture(t), a = await f.login('a'), b = await f.login('b');
  f.DB.sqlite.prepare("UPDATE users SET role='admin' WHERE user_id=?").run(a.session.user.id);
  f.bootstrap(b.session.user.id);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM admin_bootstrap').get().n, 0);
  f.DB.sqlite.prepare("UPDATE users SET role='buyer' WHERE user_id=?").run(a.session.user.id);
  f.DB.sqlite.prepare("UPDATE users SET role='merchant' WHERE user_id=?").run(b.session.user.id);
  f.bootstrap(b.session.user.id);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM admin_bootstrap').get().n, 0);
});

test('bootstrap CLI rejects injection, implicit execution, wrong app/config and ambiguous database mode', () => {
  const args = ['--appid', APP, '--user-id', 'wechat:' + 'a'.repeat(64)];
  assert.equal(parseBootstrapArgs(args).apply, false);
  for (const suffix of [['--remote'], ['--config', 'private.json'], ['--apply'], ['--apply', '--config', 'x', '--remote'], ['--apply', '--config', 'x', '--local', '--remote', '--confirm-appid', APP], ['--unknown', 'x']]) assert.throws(() => parseBootstrapArgs([...args, ...suffix]));
  for (const userId of ['sites-user', 'wechat:' + 'a'.repeat(64) + "';DELETE FROM users;--", 'provider-openid']) assert.throws(() => bootstrapWechatAdminSQL({ appId: APP, userId }));
  assert.equal(parseBootstrapArgs([...args, '--apply', '--config', 'private.json', '--remote', '--confirm-appid', APP]).mode, '--remote');
  const config = { vars: { AUTH_MODE: 'wechat', WECHAT_APP_ID: APP }, d1_databases: [{ binding: 'DB', database_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }] };
  assert.equal(validateBootstrapConfig(config, { appId: APP, userId: args[3] }), true);
  assert.throws(() => validateBootstrapConfig(config, { appId: OTHER_APP, userId: args[3] }));
  assert.throws(() => validateBootstrapConfig({ ...config, vars: { WECHAT_APP_ID: APP } }, { appId: APP, userId: args[3] }));
  assert.throws(() => validateBootstrapConfig({ ...config, d1_databases: [{ binding: 'DB', database_id: 'REPLACE_ME' }] }, { appId: APP, userId: args[3] }));
});

test('only current-app administrators bind verified buyers; email invitations and client role fields cannot grant access', async t => {
  const f = fixture(t), operator = await f.admin(), buyer = await f.login('buyer');
  await data(await f.call('/admin/wechat/merchants'), 401);
  await data(await f.call('/admin/wechat/merchants', { token: buyer.token }), 403);
  await data(await f.call('/admin/wechat/merchants', { mode: 'sites' }), 404);
  await data(await f.call('/admin/merchants', { token: operator.token, method: 'POST', body: { email: 'unverified@example.test' } }), 404);
  for (const extra of [{ role: 'admin' }, { email: 'unverified@example.test' }, { permissions: ['admin'] }, { permissions: ['orders','orders'] }, { userId: 'provider-openid' }]) {
    await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(buyer, extra) }), 400);
  }
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', origin: 'https://foreign.example', body: f.input(buyer) }), 403);
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(operator) }), 409);
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(buyer, { userId: 'wechat:' + '0'.repeat(64) }) }), 422);
  f.env.WECHAT_APP_ID = OTHER_APP; const outsider = await f.login('other-app'); f.env.WECHAT_APP_ID = APP;
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(outsider) }), 422);
  const profile = await f.add(operator, buyer);
  assert.equal(profile.email, ''); assert.equal(profile.userId, buyer.session.user.id); assert.equal(profile.authProvider, 'wechat'); assert.equal(profile.bound, true);
  const internal = f.DB.sqlite.prepare('SELECT email FROM merchant_accounts').get().email;
  assert.match(internal, /^wechat-account:[a-f0-9]{64}$/); assert.equal(internal.includes('@'), false);
  const session = await data(await f.call('/session', { token: buyer.token }));
  assert.equal(session.role, 'merchant'); assert.deepEqual(session.permissions, ['products','orders','aftersales']); assert.equal(session.merchant.email, '');
  assert.equal(JSON.stringify(await data(await f.call('/admin/wechat/merchants', { token: operator.token }))).includes('wechat-account:'), false);
});

test('merchant edits preserve account ownership, use versions, audit changes and immediately enforce stop/permission changes', async t => {
  const f = fixture(t), operator = await f.admin(), seller = await f.login('seller'), other = await f.login('other');
  let profile = await f.add(operator, seller);
  const path = '/admin/wechat/merchants/' + profile.id;
  await data(await f.call(path, { token: seller.token }), 403);
  await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { userId: other.session.user.id }) }), 409);
  await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { expectedVersion: 0 }) }), 400);
  profile = (await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { permissions: ['orders'], name: '模拟定边采购者' }) }))).merchant;
  assert.equal(profile.version, 2);
  await data(await f.call('/admin/products', { token: seller.token }), 403);
  await data(await f.call('/admin/orders', { token: seller.token }));
  await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { expectedVersion: 1 }) }), 409);
  profile = (await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { status: 'disabled' }) }))).merchant;
  assert.equal((await data(await f.call('/session', { token: seller.token }))).canManage, false);
  await data(await f.call('/admin/orders', { token: seller.token }), 403);
  profile = (await data(await f.call(path, { method: 'PUT', token: operator.token, body: f.editInput(profile, { status: 'enabled', permissions: ['aftersales'] }) }))).merchant;
  const session = await data(await f.call('/session', { token: seller.token }));
  assert.deepEqual(session.permissions, ['aftersales']);
  const events = (await data(await f.call(path + '/audit', { token: operator.token }))).events;
  assert.deepEqual(events.map(value => value.action), ['updated','updated','updated','created']);
  assert.equal(events[3].after.userId, seller.session.user.id);
  assert.equal(JSON.stringify(events).includes('wechat-account:'), false);
});

test('new WeChat merchant bindings retain product, inventory and order ownership boundaries', async t => {
  const f = fixture(t), operator = await f.admin(), seller = await f.login('seller'), other = await f.login('other');
  await f.add(operator, seller); await f.add(operator, other);
  const product = { ...normalizeCatalogProduct(BASE_CATALOG[0]), id: 'seller-apples', status: 'published' };
  await data(await f.call('/admin/products/' + product.id, { token: seller.token, method: 'PUT', body: { product, expectedVersion: 0 } }));
  const listed = (await data(await f.call('/admin/products', { token: other.token }))).products;
  assert.equal(listed.length, 0);
  await data(await f.call('/admin/products/' + product.id, { token: other.token, method: 'PUT', body: { product, expectedVersion: 1 } }), 403);
  const inventory = { expectedVersion: 0, stocks: { small: 2, family: 1 }, batchCode: 'TEST', harvestDate: '', note: '模拟', reason: '模拟' };
  await data(await f.call('/admin/inventory/' + product.id, { token: other.token, method: 'PUT', body: inventory }), 404);
  await data(await f.call('/admin/inventory/' + product.id, { token: seller.token, method: 'PUT', body: inventory }));
  const buyer = await f.login('order-buyer'), selection = { items: [{ productId: product.id, variant: 'small', quantity: 1 }], address: 'gansu' };
  const quote = (await data(await f.call('/orders/quote', { token: buyer.token, method: 'POST', body: selection }))).quote;
  let order = (await data(await f.call('/orders', { token: buyer.token, method: 'POST', body: { ...selection, expectedTotal: quote.total,
    productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: crypto.randomUUID() } }), 201)).order;
  await data(await f.call('/admin/orders/' + order.id, { token: other.token }), 404);
  await data(await f.call('/admin/orders/' + order.id + '/ship', { token: other.token, method: 'POST', body: { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-OWNER-ONLY' } }), 404);
  order = (await data(await f.call('/admin/orders/' + order.id + '/ship', { token: seller.token, method: 'POST', body: { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-OWNER-ONLY' } }))).order;
  order = (await data(await f.call('/orders/' + order.id + '/aftersale', { token: buyer.token, method: 'POST', body: { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '模拟售后', hasEvidence: false } }))).order;
  await data(await f.call('/admin/orders/' + order.id + '/aftersale/resolve', { token: other.token, method: 'POST', body: { expectedVersion: order.version, reply: '无权处理' } }), 404);
  await data(await f.call('/admin/orders/' + order.id + '/aftersale/resolve', { token: seller.token, method: 'POST', body: { expectedVersion: order.version, reply: '模拟处理完成' } }));
});

test('bindings and audits roll back together; duplicate/concurrent requests cannot create duplicate profiles', async t => {
  const f = fixture(t), operator = await f.admin(), seller = await f.login('seller');
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO merchant_audit');
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(seller) }), 503);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM merchant_accounts').get().n, 0);
  assert.equal((await data(await f.call('/session', { token: seller.token }))).role, 'buyer');
  f.DB.failSQL = null;
  const responses = await Promise.all([1,2].map(() => f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(seller) })));
  assert.deepEqual(responses.map(value => value.status).sort(), [201,409]);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM merchant_accounts').get().n, 1);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM merchant_audit').get().n, 1);
  const profile = (await data(await f.call('/admin/wechat/merchants', { token: operator.token }))).merchants[0];
  f.DB.failSQL = sql => sql.startsWith('INSERT INTO merchant_audit');
  await data(await f.call('/admin/wechat/merchants/' + profile.id, { token: operator.token, method: 'PUT', body: f.editInput(profile, { status: 'disabled' }) }), 503);
  assert.equal((await data(await f.call('/session', { token: seller.token }))).canManage, true);
  f.DB.failSQL = null;
  const edits = await Promise.all([1,2].map(() => f.call('/admin/wechat/merchants/' + profile.id, { token: operator.token, method: 'PUT', body: f.editInput(profile, { status: 'disabled' }) })));
  assert.deepEqual(edits.map(value => value.status).sort(), [200,409]);
});

test('administrator revocation during a write blocks creation without changing the target role', async t => {
  const f = fixture(t), operator = await f.admin(), seller = await f.login('seller');
  f.DB.beforeBatch = () => f.DB.sqlite.prepare("UPDATE users SET role='buyer' WHERE user_id=?").run(operator.session.user.id);
  await data(await f.call('/admin/wechat/merchants', { token: operator.token, method: 'POST', body: f.input(seller) }), 409);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM merchant_accounts').get().n, 0);
  assert.equal((await data(await f.call('/session', { token: seller.token }))).role, 'buyer');
});
