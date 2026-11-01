#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE_CATALOG } from '../public/model.js';

// These fake identity headers are allowed ONLY against a local test Worker.
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.username + base.password + base.search + base.hash, '');
  assert.equal(base.pathname, '/');
} catch {
  console.error('Merchant smoke test requires an HTTP loopback root URL, without credentials or redirects.');
  process.exit(1);
}

const suffix = randomUUID().slice(0, 8);
const admin = { id: process.env.SMOKE_ADMIN_ID || 'local_seedy', email: process.env.SMOKE_ADMIN_EMAIL || 'seedy@sites.test' };
const a = { id: `merchant-smoke-a-${suffix}`, email: `merchant-smoke-a-${suffix}@example.test` };
const b = { id: `merchant-smoke-b-${suffix}`, email: `merchant-smoke-b-${suffix}@example.test` };
const buyer = { id: `merchant-smoke-buyer-${suffix}`, email: `merchant-smoke-buyer-${suffix}@example.test` };
const fullPermissions = ['products', 'orders', 'aftersales'];
const profiles = new Map();
let checks = 0;
const createdOrders = [];

async function call(path, { user = admin, method = 'GET', body, expected = 200 } = {}) {
  assert.ok(path.startsWith('/api/v1/'));
  const headers = { Accept: 'application/json' };
  if (user) { headers['oai-authenticated-user-id'] = user.id; headers['oai-authenticated-user-email'] = user.email; }
  if (body !== undefined) { headers.Origin = base.origin; headers['Content-Type'] = 'application/json'; }
  const response = await fetch(base.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(15000) });
  let result;
  try { result = await response.json(); } catch { throw new Error(`${method} ${path}: response was not JSON`); }
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}; code=${result?.error?.code || 'none'}`);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  checks++;
  return result;
}
const post = (path, body, user = admin, expected = 200) => call('/api/v1' + path, { user, method: 'POST', body, expected });
async function createMerchant(user, name, region) {
  const result = await post('/admin/merchants', { name, region, email: user.email, status: 'enabled', permissions: fullPermissions }, admin, 201);
  assert.equal(result.merchant.bound, false); assert.equal(result.merchant.version, 1);
  profiles.set(user.id, result.merchant);
  return result.merchant;
}
async function updateMerchant(user, patch) {
  const previous = profiles.get(user.id);
  const input = { name: previous.name, region: previous.region, email: previous.email, status: previous.status, permissions: previous.permissions, ...patch, expectedVersion: previous.version };
  const result = await call('/api/v1/admin/merchants/' + previous.id, { method: 'PUT', body: input });
  profiles.set(user.id, result.merchant);
  return result.merchant;
}
async function createProduct(user, id, name) {
  const product = { ...structuredClone(BASE_CATALOG[0]), id, name, status: 'published' };
  const result = await call('/api/v1/admin/products/' + id, { user, method: 'PUT', body: { product, expectedVersion: 0 } });
  assert.equal(result.product.id, id); assert.equal(result.product.version, 1);
  const current = (await call('/api/v1/admin/inventory', { user })).inventories.find(value => value.productId === id);
  assert.ok(current);
  await call('/api/v1/admin/inventory/' + id, { user, method: 'PUT', body: {
    expectedVersion: current.version, stocks: { small: 10, family: 10 }, batchCode: `MERCHANT-SMOKE-${suffix}`,
    harvestDate: new Date().toISOString().slice(0, 10), note: '本机采购者验收专用模拟批次。', reason: '配置本机采购者模拟库存'
  } });
  return result.product;
}
async function createOrder(productId) {
  const items = [{ productId, variant: 'small', quantity: 1 }];
  const { quote } = await post('/orders/quote', { items, address: 'gansu' }, buyer);
  const input = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: `MERCHANT-SMOKE-${randomUUID()}` };
  const result = await post('/orders', input, buyer, 201);
  assert.equal(result.order.version, 1); assert.equal(result.order.total, quote.total);
  createdOrders.push(result.order.id);
  return { order: result.order, input };
}

try {
  const operator = await call('/api/v1/session');
  assert.equal(operator.role, 'admin'); assert.equal(operator.canManage, true);
  await call('/api/v1/admin/merchants', { user: null, expected: 401 });
  await createMerchant(a, '景泰采购员（本机验收模拟）', '甘肃 · 景泰');
  await createMerchant(b, '定边采购员（本机验收模拟）', '陕西 · 定边');
  for (const user of [a, b]) {
    const session = await call('/api/v1/session', { user });
    assert.equal(session.user.id, user.id); assert.equal(session.role, 'merchant'); assert.equal(session.canManage, true);
    assert.deepEqual([...session.permissions].sort(), [...fullPermissions].sort());
    const { merchant } = await call('/api/v1/admin/merchants/' + profiles.get(user.id).id);
    assert.equal(merchant.bound, true); profiles.set(user.id, merchant);
  }
  const imposter = await call('/api/v1/session', { user: { id: `merchant-smoke-imposter-${suffix}`, email: a.email } });
  assert.equal(imposter.role, 'buyer'); assert.equal(imposter.canManage, false);
  await call('/api/v1/admin/merchants', { user: a, expected: 403 });

  const productA = await createProduct(a, `smoke-merchant-a-${suffix}`, '景泰苹果（本机验收模拟）');
  const productB = await createProduct(b, `smoke-merchant-b-${suffix}`, '定边苹果（本机验收模拟）');
  const aProducts = (await call('/api/v1/admin/products', { user: a })).products;
  assert.ok(aProducts.some(item => item.id === productA.id)); assert.ok(!aProducts.some(item => item.id === productB.id));
  await call('/api/v1/admin/products/' + productA.id, { user: b, method: 'PUT', body: { product: productA, expectedVersion: 1 }, expected: 403 });
  let { order, input } = await createOrder(productA.id);
  const second = (await createOrder(productA.id)).order;
  await createOrder(productB.id);
  const bOrders = (await call('/api/v1/admin/orders', { user: b })).orders;
  assert.ok(!bOrders.some(value => value.id === order.id));
  await call('/api/v1/admin/orders/' + order.id, { user: b, expected: 404 });
  await post('/admin/orders/' + order.id + '/ship', { expectedVersion: 1, carrier: '模拟物流', tracking: 'DEMO-FORBIDDEN' }, b, 404);
  order = (await post('/admin/orders/' + order.id + '/note', { expectedVersion: order.version, note: '本机模拟内部备注' }, a)).order;
  const buyerView = (await call('/api/v1/orders/' + order.id, { user: buyer })).order;
  assert.equal(buyerView.merchantNote, undefined);
  order = (await post('/admin/orders/' + order.id + '/ship', { expectedVersion: order.version, carrier: '模拟物流', tracking: `DEMO-MERCHANT-${suffix.toUpperCase()}` }, a)).order;
  assert.equal(order.fulfillment.status, 'shipped');
  order = (await post('/orders/' + order.id + '/aftersale', { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '本机验收模拟坏果，无真实客户信息。', hasEvidence: false }, buyer)).order;
  await post('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '不允许跨商家处理' }, b, 404);

  const oldProfileVersion = profiles.get(a.id).version;
  await updateMerchant(a, { permissions: ['aftersales'] });
  const afterOnly = await call('/api/v1/session', { user: a });
  assert.deepEqual(afterOnly.permissions, ['aftersales']); assert.equal(afterOnly.canManage, true);
  await call('/api/v1/admin/products', { user: a, expected: 403 });
  await post('/admin/orders/' + second.id + '/ship', { expectedVersion: second.version, carrier: '模拟物流', tracking: 'DEMO-DENIED' }, a, 403);
  await post('/admin/orders/' + order.id + '/note', { expectedVersion: order.version, note: '售后权限不能修改备注' }, a, 403);
  const afterOrders = (await call('/api/v1/admin/orders', { user: a })).orders;
  assert.ok(afterOrders.some(value => value.id === order.id)); assert.ok(!afterOrders.some(value => value.id === second.id));
  await call('/api/v1/admin/orders/' + second.id, { user: a, expected: 404 });
  order = (await post('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '本机模拟退款完成，实际退款0元。' }, a)).order;
  assert.equal(order.afterSale.status, 'resolved'); assert.deepEqual(order.afterSaleHistory.map(item => item.status), ['submitted', 'resolved']);

  const active = profiles.get(a.id);
  const auditBeforeConflict = await call('/api/v1/admin/merchants/' + active.id + '/audit');
  await call('/api/v1/admin/merchants/' + active.id, { method: 'PUT', body: { name: active.name, region: active.region, email: active.email, permissions: fullPermissions, status: 'enabled', expectedVersion: oldProfileVersion }, expected: 409 });
  assert.deepEqual((await call('/api/v1/admin/merchants/' + active.id + '/audit')).events, auditBeforeConflict.events);
  await updateMerchant(a, { status: 'disabled' });
  const disabled = await call('/api/v1/session', { user: a });
  assert.equal(disabled.canManage, false); assert.deepEqual(disabled.permissions, []);
  await call('/api/v1/admin/orders', { user: a, expected: 403 });
  assert.ok(!(await call('/api/v1/products', { user: null })).products.some(value => value.id === productA.id));
  await post('/orders/quote', { items: [{ productId: productA.id, variant: 'small', quantity: 1 }], address: 'gansu' }, buyer, 409);
  const replay = await post('/orders', input, buyer);
  assert.equal(replay.replayed, true); assert.equal(replay.order.id, order.id);
  await updateMerchant(a, { status: 'enabled', permissions: fullPermissions });
  const reenabled = await call('/api/v1/session', { user: a });
  assert.equal(reenabled.canManage, true);
  assert.equal((await call('/api/v1/admin/orders/' + order.id, { user: a })).order.afterSale.status, 'resolved');
  assert.ok((await call('/api/v1/products', { user: null })).products.some(value => value.id === productA.id));
  const audit = await call('/api/v1/admin/merchants/' + active.id + '/audit');
  assert.ok(audit.events.length >= 4); assert.ok(audit.events.some(event => event.after?.status === 'disabled'));
  assert.equal((await call('/api/v1/session')).role, 'admin');
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks, merchantsCreated: profiles.size, simulatedOrders: createdOrders.length, message: error.message }));
  process.exitCode = 1;
} finally {
  // Preserve histories, but prevent these local-only mock products being sold.
  let cleanupFailed = false;
  for (const [id, profile] of profiles) {
    try {
      const current = (await call('/api/v1/admin/merchants/' + profile.id)).merchant;
      profiles.set(id, current);
      if (current.status !== 'disabled') await updateMerchant({ id }, { status: 'disabled' });
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) { console.error('Some local mock merchants could not be disabled; inspect the local test database before reusing it.'); process.exitCode = 1; }
}
if (!process.exitCode) console.log(JSON.stringify({ result: 'PASS', checks, merchants: profiles.size, simulatedOrders: createdOrders.length, simulated: true, payment: false }));
