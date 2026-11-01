import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { handleApi } from '../server/cloud-api.js';
import { wechatDigest } from '../server/wechat-auth.js';
import worker from '../wechat-worker/worker.js';

const migrations = await Promise.all((await readdir(new URL('../drizzle/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8')));
const ORIGIN = 'https://native-api.example.test';
const APP = 'wx0123456789abcdef', SECRET = 'example-server-only-secret';
const OWNER = { id: 'sites-owner', email: 'owner@example.test' };
const OPENID = 'provider-only-openid', KEY = 'provider-only-session-key';
class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute(mode) {
    if (this.db.failSQL?.(this.sql)) throw new Error('private SQL failure');
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
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON;'); for (const sql of migrations) this.sqlite.exec(sql); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute('run')); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  return response.json();
}
function fixture(t) {
  const DB = new D1(); t.after(() => DB.sqlite.close());
  const env = { DB, AUTH_MODE: 'wechat', WECHAT_APP_ID: APP, WECHAT_APP_SECRET: SECRET, BOOTSTRAP_ADMIN_EMAIL: OWNER.email };
  const calls = [];
  const provider = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(parsed.searchParams.get('appid'), env.WECHAT_APP_ID);
    assert.equal(parsed.searchParams.get('secret'), SECRET);
    assert.equal(parsed.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ openid: OPENID, session_key: KEY }));
  };
  const call = (path, { method = 'GET', body, token, origin, sitesUser, useSites = false, fetcher = provider, extraHeaders = {} } = {}) => {
    const headers = new Headers(extraHeaders);
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (origin !== undefined) headers.set('Origin', origin);
    if (sitesUser) { headers.set('oai-authenticated-user-id', sitesUser.id); headers.set('oai-authenticated-user-email', sitesUser.email); }
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return handleApi(new Request(ORIGIN + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
      useSites ? { ...env, AUTH_MODE: undefined } : env, { wechatProviderFetch: fetcher });
  };
  let counter = 0;
  const login = (options = {}) => call('/auth/wechat/login', { method: 'POST', body: { code: `code-${++counter}` }, ...options });
  const count = table => DB.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const seed = async () => {
    await data(await call('/session', { sitesUser: OWNER, useSites: true }));
    await data(await call('/admin/seed', { sitesUser: OWNER, useSites: true, method: 'POST', origin: ORIGIN, body: {} }));
    await data(await call('/admin/inventory/jingtai-apple', { sitesUser: OWNER, useSites: true, method: 'PUT', origin: ORIGIN,
      body: { expectedVersion: 0, stocks: { small: 3, family: 2 }, batchCode: 'WX-TEST-MOCK', harvestDate: '', note: '微信接口模拟测试', reason: '接口测试' } }));
  };
  return { DB, env, call, login, calls, count, seed };
}

test('WeChat schema creates no account, inventory, session or code seed', t => {
  const f = fixture(t);
  for (const table of ['wechat_sessions', 'wechat_identities', 'wechat_login_codes', 'users', 'product_inventory']) assert.equal(f.count(table), 0);
});

test('verified code creates buyer-only opaque session and persists only hashes, never provider keys or secrets', async t => {
  const f = fixture(t), result = await data(await f.login());
  assert.match(result.token, /^wxs_[a-f0-9]{64}$/);
  assert.ok(Date.parse(result.expiresAt) > Date.now() + 6 * 86400000);
  assert.equal(result.session.role, 'buyer'); assert.equal(result.session.canManage, false); assert.deepEqual(result.session.permissions, []);
  assert.equal(result.session.user.email, ''); assert.match(result.session.user.id, /^wechat:[a-f0-9]{64}$/);
  assert.equal(result.session.authProvider, 'wechat'); assert.equal(result.session.signInUrl, null);
  const dump = JSON.stringify(['wechat_sessions', 'wechat_identities', 'wechat_login_codes', 'users'].map(table => f.DB.sqlite.prepare(`SELECT * FROM ${table}`).all()));
  for (const secret of [result.token, 'code-1', OPENID, KEY, SECRET]) { assert.equal(dump.includes(secret), false); assert.equal(JSON.stringify(result.session).includes(secret), false); }
  assert.equal(f.DB.sqlite.prepare('SELECT token_hash FROM wechat_sessions').get().token_hash, await wechatDigest(result.token));
  assert.equal(f.count('admin_bootstrap'), 0);
  assert.deepEqual(await data(await f.call('/session', { token: result.token })), result.session);
});

test('repeated login resolves same AppID subject, distinct AppID is isolated, and code replay never issues a second token', async t => {
  const f = fixture(t), a = await data(await f.login()), b = await data(await f.login());
  assert.equal(a.session.user.id, b.session.user.id); assert.notEqual(a.token, b.token); assert.equal(f.count('users'), 1);
  await data(await f.login({ body: { code: 'code-1' } }), 409); assert.equal(f.calls.length, 2); assert.equal(f.count('wechat_sessions'), 2);
  f.env.WECHAT_APP_ID = 'wx1111111111111111';
  await data(await f.call('/session', { token: a.token }), 401);
  const c = await data(await f.login()); assert.notEqual(c.session.user.id, a.session.user.id); assert.equal(f.count('users'), 2);
});

test('concurrent use of a code has one transactional winner even if provider stub accepts both exchanges', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.login({ body: { code: 'concurrent' } }), f.login({ body: { code: 'concurrent' } })]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  assert.equal(f.count('wechat_sessions'), 1); assert.equal(f.count('wechat_login_codes'), 1); assert.equal(f.count('users'), 1);
});

test('Sites identity headers and client-supplied role or OpenID cannot grant access in native mode', async t => {
  const f = fixture(t); await f.seed();
  const anonymous = await data(await f.call('/session', { sitesUser: OWNER }));
  assert.equal(anonymous.user, null); assert.equal(anonymous.canManage, false);
  await data(await f.call('/admin/products', { sitesUser: OWNER }), 401);
  for (const body of [{ code: 'c', role: 'admin' }, { code: 'c', openid: OPENID }, { code: 'c', email: OWNER.email }, { code: 'c', userId: OWNER.id }]) await data(await f.login({ body }), 400);
  const buyer = await data(await f.login());
  await data(await f.call('/admin/products', { token: buyer.token, sitesUser: OWNER }), 403);
  assert.equal(f.count('admin_bootstrap'), 1);
});

test('native sessions never claim email-invited merchants or bootstrap administration', async t => {
  const f = fixture(t); await f.seed();
  await data(await f.call('/admin/merchants', { sitesUser: OWNER, useSites: true, method: 'POST', origin: ORIGIN,
    body: { name: '模拟采购者', email: 'merchant@example.test', region: '甘肃景泰', status: 'enabled', permissions: ['products','orders','aftersales'] } }), 201);
  const result = await data(await f.login()); assert.equal(result.session.role, 'buyer'); assert.equal(result.session.merchant, null);
  assert.equal(f.DB.sqlite.prepare('SELECT user_id FROM merchant_accounts').get().user_id, null);
});

test('foreign browser origins are rejected while native bearer writes work without Origin and Sites CSRF is unchanged', async t => {
  const f = fixture(t);
  await data(await f.login({ origin: 'https://evil.example' }), 403); assert.equal(f.calls.length, 0);
  const logged = await data(await f.login());
  const state = { cart: [], favorites: [], recent: [], preferredAddress: 'gansu' };
  await data(await f.call('/me/shopping', { method: 'PUT', token: logged.token, body: { expectedVersion: 0, state }, origin: 'https://evil.example' }), 403);
  await data(await f.call('/me/shopping', { method: 'PUT', token: logged.token, body: { expectedVersion: 0, state } }));
  await data(await f.call('/admin/seed', { method: 'POST', body: {}, sitesUser: OWNER, useSites: true }), 403);
  await data(await f.call('/auth/wechat/login', { method: 'POST', body: { code: 'not-sites' }, useSites: true }), 404);
});

test('logout revokes only current token, is idempotent, and expired or malformed sessions are rejected', async t => {
  const f = fixture(t), a = await data(await f.login()), b = await data(await f.login());
  await data(await f.call('/auth/wechat/logout', { method: 'POST', body: {}, token: a.token }));
  await data(await f.call('/auth/wechat/logout', { method: 'POST', body: {}, token: a.token }));
  await data(await f.call('/session', { token: a.token }), 401);
  await data(await f.call('/session', { token: b.token }));
  f.DB.sqlite.prepare('UPDATE wechat_sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  await data(await f.call('/session', { token: b.token }), 401);
  await data(await f.call('/session', { token: 'not-a-token' }), 401);
  await data(await f.call('/auth/wechat/logout', { method: 'POST', body: {}, token: undefined }), 401);
});

test('login configuration, malformed code, provider errors, redirect/network failures and oversized replies fail without data writes or secret leakage', async t => {
  const f = fixture(t);
  for (const body of [{}, { code: '' }, { code: 'x'.repeat(129) }, { code: 'with space' }, [], null]) await data(await f.login({ body }), 400);
  await data(await f.login({ body: '{"code":"' + 'x'.repeat(1100) + '"}' }), 413);
  const original = f.env.WECHAT_APP_SECRET; f.env.WECHAT_APP_SECRET = '';
  await data(await f.login(), 503); f.env.WECHAT_APP_SECRET = original;
  const cases = [
    [() => { throw new Error(SECRET); }, 502],
    [() => new Response('', { status: 307, headers: { Location: 'https://evil.example' } }), 502],
    [() => new Response(JSON.stringify({ errcode: 40029, errmsg: SECRET })), 401],
    [() => new Response(JSON.stringify({ errcode: 45011, errmsg: SECRET })), 429],
    [() => new Response(JSON.stringify({ errcode: -1, errmsg: SECRET })), 502],
    [() => new Response('not JSON ' + SECRET), 502],
    [() => new Response('x'.repeat(8200)), 502],
    [() => new Response(JSON.stringify({ openid: OPENID })), 502]
  ];
  for (const [fetcher, status] of cases) {
    const result = await data(await f.login({ fetcher }), status);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  for (const table of ['users','wechat_sessions','wechat_identities','wechat_login_codes']) assert.equal(f.count(table), 0);
});

test('session insert failure atomically rolls back identity, user and consumed-code marker', async t => {
  const f = fixture(t); f.DB.failSQL = sql => sql.startsWith('INSERT INTO wechat_sessions');
  await data(await f.login({ body: { code: 'rollback-code' } }), 503);
  for (const table of ['users','wechat_sessions','wechat_identities','wechat_login_codes']) assert.equal(f.count(table), 0);
  f.DB.failSQL = null; await data(await f.login({ body: { code: 'rollback-code' } }));
});

test('public Worker enforces native identity even if configuration says Sites, strips spoofed headers and exposes no maintenance or webpage', async t => {
  const f = fixture(t); await f.seed();
  const response = await worker.fetch(new Request(ORIGIN + '/api/v1/session', { headers: { 'oai-authenticated-user-id': OWNER.id, 'oai-authenticated-user-email': OWNER.email } }), { ...f.env, AUTH_MODE: 'sites' });
  assert.equal(response.headers.get('Vary'), 'Authorization');
  assert.equal((await data(response)).user, null);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/'), f.env)).status, 404);
  assert.equal((await worker.fetch(new Request('http://public-api.example.test/api/v1/session'), f.env)).status, 400);
  assert.equal((await worker.fetch(new Request(ORIGIN + '/api/v1/maintenance/demo-inventory', { method: 'POST', body: '{}' }), f.env)).status, 404);
});

test('native buyer can quote, place an idempotent order, read only their records and confirm shipped order', async t => {
  const f = fixture(t); await f.seed();
  const a = await data(await f.login()), b = await data(await f.login({ fetcher: async () => new Response(JSON.stringify({ openid: 'second-buyer-openid', session_key: KEY })) }));
  const items = [{ productId: 'jingtai-apple', variant: 'small', quantity: 1 }];
  const quote = (await data(await f.call('/orders/quote', { method: 'POST', token: a.token, body: { items, address: 'gansu' } }))).quote;
  const body = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: crypto.randomUUID() };
  let order = (await data(await f.call('/orders', { method: 'POST', token: a.token, body }), 201)).order;
  const repeated = await data(await f.call('/orders', { method: 'POST', token: a.token, body }));
  assert.equal(repeated.order.id, order.id);
  await data(await f.call('/orders/' + order.id, { token: b.token }), 404);
  assert.equal(f.DB.sqlite.prepare('SELECT small_stock FROM product_inventory WHERE product_id=?').get('jingtai-apple').small_stock, 2);
  order = (await data(await f.call('/admin/orders/' + order.id + '/ship', { method: 'POST', sitesUser: OWNER, useSites: true, origin: ORIGIN,
    body: { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-WECHAT-TEST' } }))).order;
  order = (await data(await f.call('/orders/' + order.id + '/receive', { method: 'POST', token: a.token, body: { expectedVersion: order.version } }))).order;
  assert.equal(order.receipt.status, 'received');
  order = (await data(await f.call('/orders/' + order.id + '/aftersale', { method: 'POST', token: a.token,
    body: { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '微信接口模拟售后', hasEvidence: false } }))).order;
  assert.equal(order.afterSale.status, 'submitted');
});
