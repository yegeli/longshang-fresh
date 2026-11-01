#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE_CATALOG } from '../public/model.js';

// Raw identity headers simulate the trusted dispatch ONLY on a loopback Worker.
// Never permit production URLs, credentials, redirects, or a different API base.
let base;
try {
  base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
  assert.equal(base.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.username + base.password + base.search + base.hash, '');
  assert.equal(base.pathname, '/');
} catch {
  console.error('Local smoke test requires an http://127.0.0.1[:port] or http://localhost[:port] root URL.');
  process.exit(1);
}

const run = randomUUID();
const admin = { id: process.env.SMOKE_ADMIN_ID || 'local_seedy', email: process.env.SMOKE_ADMIN_EMAIL || 'seedy@sites.test' };
const buyerA = { id: `smoke-a-${run}`, email: `smoke-a-${run}@example.test` };
const buyerB = { id: `smoke-b-${run}`, email: `smoke-b-${run}@example.test` };
let checks = 0;
const orders = [];
let testProduct;

async function call(path, { user = null, method = 'GET', body, expected = 200 } = {}) {
  assert.ok(path.startsWith('/api/v1/'));
  const headers = { Accept: 'application/json' };
  if (user) { headers['oai-authenticated-user-id'] = user.id; headers['oai-authenticated-user-email'] = user.email; }
  if (body !== undefined) { headers.Origin = base.origin; headers['Content-Type'] = 'application/json'; }
  const response = await fetch(base.origin + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`${method} ${path}: response was not JSON`); }
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}; code=${result?.error?.code || 'none'}`);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  checks++;
  return result;
}
const mutation = (path, body, user, expected = 200) => call('/api/v1' + path, { method: 'POST', body, user, expected });
const readOrder = (id, user = buyerA) => call('/api/v1/orders/' + id, { user });

async function create(items) {
  const { quote } = await mutation('/orders/quote', { items, address: 'gansu' }, buyerA);
  assert.equal(quote.address, 'gansu'); assert.ok(Number.isSafeInteger(quote.total) && quote.total > 0);
  assert.equal(quote.total, quote.subtotal + quote.shipping);
  const input = { items, address: 'gansu', expectedTotal: quote.total, productVersions: quote.productVersions, inventoryVersions: quote.inventoryVersions, idempotencyKey: `SMOKE-${randomUUID()}` };
  const created = await mutation('/orders', input, buyerA, 201);
  assert.equal(created.replayed, false); assert.equal(created.order.total, quote.total);
  assert.equal(created.order.version, 1); assert.equal(created.order.status, 'created');
  assert.equal(created.order.fulfillment, undefined); assert.equal(created.order.payment, undefined);
  assert.match(created.order.id, /^DEMO-[A-F0-9-]{36}$/);
  orders.push(created.order.id);
  return { order: created.order, input };
}

try {
  const operator = await call('/api/v1/session', { user: admin });
  assert.equal(operator.user?.id, admin.id); assert.equal(operator.canManage, true, 'Local operator must already have management permission.');
  const customer = await call('/api/v1/session', { user: buyerA });
  assert.equal(customer.role, 'buyer'); assert.equal(customer.canManage, false);
  await call('/api/v1/orders', { expected: 401 });
  assert.equal(operator.role, 'admin', 'The local smoke test creates a dedicated simulated product.');
  const product = { ...structuredClone(BASE_CATALOG[0]), id: `smoke-orders-${run.slice(0, 8)}`, name: '订单验收苹果（本机模拟）', status: 'published' };
  testProduct = (await call('/api/v1/admin/products/' + product.id, { user: admin, method: 'PUT', body: { product, expectedVersion: 0 } })).product;
  const currentInventory = (await call('/api/v1/admin/inventory', { user: admin })).inventories.find(value => value.productId === product.id);
  assert.ok(currentInventory);
  await call('/api/v1/admin/inventory/' + product.id, { user: admin, method: 'PUT', body: {
    expectedVersion: currentInventory.version, stocks: { small: 10, family: 10 }, batchCode: `ORDERS-SMOKE-${run.slice(0, 8)}`,
    harvestDate: new Date().toISOString().slice(0, 10), note: '本机自动验收专用模拟批次，不代表真实货源。', reason: '配置本机订单验收模拟库存'
  } });
  const items = [{ productId: product.id, variant: product.variants[0].id, quantity: 1 }];
  let { order, input } = await create(items);
  const replay = await mutation('/orders', input, buyerA);
  assert.equal(replay.replayed, true); assert.equal(replay.order.id, order.id);
  assert.deepEqual((await readOrder(order.id, { ...buyerA })).order, order, 'An independent request must read the persisted order.');
  const listed = await call('/api/v1/orders', { user: buyerA });
  assert.equal(listed.orders.filter(value => value.id === order.id).length, 1);
  const denied = await call('/api/v1/orders/' + order.id, { user: buyerB, expected: 404 });
  assert.equal(denied.error?.code, 'not_found');
  const isolated = await call('/api/v1/orders', { user: buyerB });
  assert.equal(isolated.orders.length, 0);
  await call('/api/v1/admin/orders', { user: buyerB, expected: 403 });
  await mutation('/admin/orders/' + order.id + '/ship', { expectedVersion: 1, carrier: '模拟物流', tracking: 'DEMO-FORBIDDEN' }, buyerB, 403);

  const adminList = await call('/api/v1/admin/orders', { user: admin });
  // Existing local histories may have more than one page; details still authorize independently.
  assert.ok(Array.isArray(adminList.orders));
  const managed = await call('/api/v1/admin/orders/' + order.id, { user: admin });
  assert.equal(managed.order.id, order.id);
  order = (await mutation('/admin/orders/' + order.id + '/ship', { expectedVersion: 1, carrier: '验收模拟物流', tracking: `DEMO-${run.toUpperCase()}` }, admin)).order;
  assert.equal(order.version, 2); assert.equal(order.fulfillment?.status, 'shipped');
  assert.match(order.fulfillment.tracking, /^DEMO-/);
  const onSecondClient = (await readOrder(order.id, { ...buyerA })).order;
  assert.deepEqual(onSecondClient.fulfillment, order.fulfillment);
  await mutation('/orders/' + order.id + '/cancel', { expectedVersion: 1 }, buyerA, 409);
  await mutation('/orders/' + order.id + '/cancel', { expectedVersion: order.version }, buyerA, 409);

  order = (await mutation('/orders/' + order.id + '/aftersale', { expectedVersion: order.version, type: 'refund', reason: 'damaged', description: '本机自动验收：模拟坏果，无真实收货资料。', hasEvidence: false }, buyerA)).order;
  assert.equal(order.afterSale?.status, 'submitted'); assert.equal(order.afterSaleHistory.length, 1);
  await mutation('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: 2, reply: '旧版本不得处理' }, admin, 409);
  order = (await mutation('/admin/orders/' + order.id + '/aftersale/resolve', { expectedVersion: order.version, reply: '本机验收：模拟退款完成，实际退款0元。' }, admin)).order;
  const resolved = (await readOrder(order.id, { ...buyerA })).order;
  assert.equal(resolved.version, order.version); assert.equal(resolved.afterSale?.status, 'resolved');
  assert.equal(resolved.afterSale.merchantReply, '本机验收：模拟退款完成，实际退款0元。');
  assert.deepEqual(resolved.afterSaleHistory.map(value => value.status), ['submitted', 'resolved']);

  // A second order covers buyer withdrawal and cancellation without shipping.
  let second = (await create(items)).order;
  second = (await mutation('/orders/' + second.id + '/aftersale', { expectedVersion: second.version, type: 'replacement', reason: 'other', description: '本机验收：撤回与取消测试。', hasEvidence: false }, buyerA)).order;
  second = (await mutation('/orders/' + second.id + '/aftersale/withdraw', { expectedVersion: second.version }, buyerA)).order;
  assert.equal(second.afterSale.status, 'withdrawn');
  second = (await mutation('/orders/' + second.id + '/cancel', { expectedVersion: second.version }, buyerA)).order;
  const cancelled = (await readOrder(second.id, { ...buyerA })).order;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 4);
  assert.deepEqual(cancelled.afterSaleHistory.map(value => value.status), ['submitted', 'withdrawn']);
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', checks, ordersCreated: orders.length, message: error.message }));
  process.exitCode = 1;
} finally {
  if (testProduct) {
    try {
      await call('/api/v1/admin/products/' + testProduct.id, { user: admin, method: 'PUT', body: { product: { ...testProduct, status: 'offline' }, expectedVersion: testProduct.version } });
    } catch { console.error('The dedicated local test product could not be taken offline.'); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log(JSON.stringify({ result: 'PASS', checks, orders, simulated: true, payment: false, realShipment: false }));
