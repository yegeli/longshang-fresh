#!/usr/bin/env node
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Runs an isolated Worker over HTTP loopback. The provider is intercepted in
// Miniflare; no request may reach real WeChat, Sites or a production database.
const root = fileURLToPath(new URL('../', import.meta.url));
const appId = 'wx0123456789abcdef';
const provider = createFetchMock(); provider.disableNetConnect();
for (const [code, subject] of [['local-operator-code', 'local-operator-only'], ['local-buyer-code', 'local-buyer-only']]) {
  provider.get('https://api.weixin.qq.com').intercept({ path: path => path.startsWith('/sns/jscode2session?') && new URL('https://api.weixin.qq.com' + path).searchParams.get('js_code') === code, method: 'GET' })
    .reply(200, JSON.stringify({ openid: subject, session_key: 'local-provider-key-never-returned' }), { headers: { 'Content-Type': 'application/json' } }).persist();
}
const bundle = await build({ entryPoints: [root + '/wechat-worker/worker.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-05-15', host: '127.0.0.1', port: 0, fetchMock: provider,
  bindings: { AUTH_MODE: 'wechat', WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'local-provider-secret-fixture' },
  d1Databases: { DB: 'isolated-wechat-http-smoke' }, r2Buckets: { BUCKET: 'isolated-wechat-http-smoke' }
});
let checks = 0;
try {
  const base = await mf.ready;
  assert.equal(base.protocol, 'http:'); assert.equal(base.hostname, '127.0.0.1');
  const db = await mf.getD1Database('DB');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const statements = (await readFile(new URL(name, directory), 'utf8')).split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  const call = async (path, { method = 'GET', body, token, expected = 200, origin, headers: extra = {} } = {}) => {
    assert.ok(path.startsWith('/api/v1/'));
    const headers = { Accept: 'application/json', ...extra };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    const response = await fetch(new URL(path, base), { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, expected, `${method} ${path}: unexpected status; ${(await response.clone().json()).error?.code || 'success'}.`);
    assert.equal(response.headers.get('Vary'), 'Authorization');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    checks++; return response.json();
  };
  const post = (path, body, token, expected = 200) => call(path, { method: 'POST', body, token, expected });
  const anonymous = await call('/api/v1/session', { headers: { 'oai-authenticated-user-id': 'spoof-owner', 'oai-authenticated-user-email': 'owner@example.test' } });
  assert.equal(anonymous.user, null);
  await call('/api/v1/admin/products', { expected: 401 });
  const operator = await post('/api/v1/auth/wechat/login', { code: 'local-operator-code' });
  assert.equal(operator.session.role, 'buyer'); assert.match(operator.token, /^wxs_[a-f0-9]{64}$/);
  await call('/api/v1/admin/products', { token: operator.token, expected: 403 });
  await post('/api/v1/auth/wechat/login', { code: 'local-operator-code' }, undefined, 409);
  await call('/api/v1/auth/wechat/login', { method: 'POST', body: { code: 'cross-origin' }, origin: 'https://untrusted.example', expected: 403 });
  // Explicit operator fixture in this new in-memory database, not first-login
  // bootstrap behavior. No privileged setup endpoint exists in the public API.
  await db.prepare("UPDATE users SET role='admin' WHERE user_id=? AND role='buyer'").bind(operator.session.user.id).run();
  assert.equal((await call('/api/v1/session', { token: operator.token })).role, 'admin');
  await post('/api/v1/admin/seed', {}, operator.token);
  const catalog = await call('/api/v1/products'); assert.equal(catalog.products.length, 6);
  await call('/api/v1/admin/inventory/jingtai-apple', { method: 'PUT', token: operator.token, body: {
    expectedVersion: 0, stocks: { small: 4, family: 2 }, batchCode: 'LOCAL-WECHAT-SMOKE', harvestDate: '', note: '独立本机模拟库存', reason: '隔离Worker验收'
  } });
  const buyer = await post('/api/v1/auth/wechat/login', { code: 'local-buyer-code' });
  assert.equal(buyer.session.role, 'buyer'); assert.notEqual(buyer.session.user.id, operator.session.user.id);
  const state = { cart: [{ productId: 'jingtai-apple', variant: 'small', quantity: 1, selected: true }], favorites: ['jingtai-apple'], recent: ['jingtai-apple'], preferredAddress: 'gansu' };
  await call('/api/v1/me/shopping', { method: 'PUT', token: buyer.token, body: { expectedVersion: 0, state } });
  assert.deepEqual((await call('/api/v1/me/shopping', { token: buyer.token })).state, state);
  const items = [{ productId: 'jingtai-apple', variant: 'small', quantity: 1 }];
  const quote = (await post('/api/v1/orders/quote', { items, address: 'gansu' }, buyer.token)).quote;
  const input = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: crypto.randomUUID() };
  let order = (await post('/api/v1/orders', input, buyer.token, 201)).order;
  assert.equal((await post('/api/v1/orders', input, buyer.token)).order.id, order.id);
  await call('/api/v1/orders/' + order.id, { token: operator.token, expected: 404 });
  assert.equal((await call('/api/v1/inventory')).inventories.find(item => item.productId === 'jingtai-apple').stocks.small, 3);
  order = (await post('/api/v1/admin/orders/' + order.id + '/ship', { expectedVersion: order.version, carrier: '模拟物流', tracking: 'DEMO-WECHAT-HTTP' }, operator.token)).order;
  order = (await post('/api/v1/orders/' + order.id + '/receive', { expectedVersion: order.version }, buyer.token)).order;
  assert.equal(order.receipt.status, 'received');
  order = (await post('/api/v1/orders/' + order.id + '/aftersale', { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '本机HTTP模拟售后', hasEvidence: false }, buyer.token)).order;
  order = (await post('/api/v1/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '本机模拟完成，实际退款0元' }, operator.token)).order;
  assert.equal(order.afterSale.status, 'resolved');
  assert.equal((await call('/api/v1/orders/' + order.id, { token: buyer.token })).order.afterSale.merchantReply, '本机模拟完成，实际退款0元');
  await post('/api/v1/auth/wechat/logout', {}, buyer.token);
  await call('/api/v1/session', { token: buyer.token, expected: 401 });
  await post('/api/v1/maintenance/demo-inventory', {}, operator.token, 404);
  console.log(JSON.stringify({ result: 'PASS', checks, isolatedLoopbackWorker: true, interceptedWeChatProvider: true, productionWrites: 0,
    nativeLogin: true, simulatedOrder: true, shipped: true, received: true, afterSale: true, payment: false }));
} finally { await mf.dispose(); await provider.close(); }
